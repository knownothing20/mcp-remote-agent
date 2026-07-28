import fs from "node:fs/promises";
import path from "node:path";

const WORKSPACE_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

function parseNamedRemoteRoot(value) {
  const uri = value.match(/^workspace:\/\/([A-Za-z][A-Za-z0-9._-]{0,63})(?:\/(.*))?$/);
  if (uri) return { workspace: uri[1], path: `/${uri[2] || ""}` };
  const shorthand = value.match(/^([A-Za-z][A-Za-z0-9._-]{0,63}):(?:\/(.*))?$/);
  if (shorthand) return { workspace: shorthand[1], path: `/${shorthand[2] || ""}` };
  return null;
}

function normalizeNamedRoot(named) {
  if (!WORKSPACE_NAME_RE.test(named.workspace)) throw new Error("project.root has an invalid workspace name");
  const remotePath = path.posix.normalize(named.path || "/");
  return `${named.workspace}:${remotePath === "/" ? "/" : remotePath.replace(/\/$/, "")}`;
}

function normalizeRemoteRoot(root) {
  const value = String(root || "").trim();
  const named = parseNamedRemoteRoot(value);
  if (named) return normalizeNamedRoot(named);
  if (!value || !value.startsWith("/")) {
    throw new Error("project.root must be an absolute POSIX path or a named workspace path");
  }
  return path.posix.normalize(value).replace(/\/$/, "") || "/";
}

function splitRemoteRoot(root) {
  const normalized = normalizeRemoteRoot(root);
  const named = parseNamedRemoteRoot(normalized);
  if (!named) return { workspace: null, rootPath: normalized };
  return { workspace: named.workspace, rootPath: path.posix.normalize(named.path || "/") };
}

export function validateProjectProfile(name, profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error(`Project '${name}' must be an object`);
  }
  const normalized = {
    name,
    server: String(profile.server || "").trim(),
    root: normalizeRemoteRoot(profile.root),
    defaultBranch: String(profile.defaultBranch || "main").trim() || "main",
    packageManager: String(profile.packageManager || "").trim() || null,
    commands: profile.commands && typeof profile.commands === "object" ? { ...profile.commands } : {},
    agentRules: Array.isArray(profile.agentRules) ? profile.agentRules.map(String) : ["AGENTS.md"],
  };
  if (!normalized.server) throw new Error(`Project '${name}' is missing server`);
  return Object.freeze(normalized);
}

export function resolveProjectPath(profile, relativePath = ".") {
  const { workspace, rootPath } = splitRemoteRoot(profile?.root);
  const candidate = path.posix.resolve(rootPath, String(relativePath || "."));
  if (candidate !== rootPath && !candidate.startsWith(`${rootPath}/`)) {
    const error = new Error(`Path '${relativePath}' escapes project root '${profile?.root}'`);
    error.code = "EPROJECTPATH";
    throw error;
  }
  return workspace ? `${workspace}:${candidate}` : candidate;
}

export async function loadProjectProfiles(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const projects = parsed.projects && typeof parsed.projects === "object" ? parsed.projects : parsed;
  const result = new Map();
  for (const [name, profile] of Object.entries(projects || {})) {
    result.set(name, validateProjectProfile(name, profile));
  }
  return result;
}
