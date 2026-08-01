const fs = require("node:fs/promises");
const path = require("node:path");
const { createWorkspacePathGuard, workspaceResultPath } = require("./path-guard.cjs");

const DEFAULT_EXCLUDE_DIRS = Object.freeze([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  ".cache", ".venv", "venv", "__pycache__",
]);

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function stringList(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [...fallback];
}

function patternList(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    const text = value.trim();
    return text.includes("{") && text.includes("}")
      ? [text]
      : text.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [...fallback];
}

function escapeRegexChar(char) {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

function expandBraces(pattern) {
  const match = pattern.match(/\{([^{}]+)\}/);
  if (!match) return [pattern];
  const before = pattern.slice(0, match.index);
  const after = pattern.slice(match.index + match[0].length);
  const values = match[1].split(",");
  return values.flatMap((value) => expandBraces(`${before}${value}${after}`));
}

function globToRegExp(pattern) {
  const normalized = String(pattern || "**/*").replace(/\\/g, "/").replace(/^\.\//, "");
  let source = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];
    const next2 = normalized[i + 2];
    if (char === "*" && next === "*" && next2 === "/") {
      source += "(?:.*/)?";
      i += 2;
      continue;
    }
    if (char === "*" && next === "*") {
      source += ".*";
      i += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegexChar(char);
  }
  source += "$";
  return new RegExp(source);
}

function compilePatterns(value, fallback = ["**/*"]) {
  return patternList(value, fallback)
    .flatMap(expandBraces)
    .map(globToRegExp);
}

function matchesAny(relativePath, matchers) {
  return matchers.some((matcher) => matcher.test(relativePath));
}

function createFileSearchService({ workspaceRoot, workspaceScope } = {}) {
  if (!workspaceRoot) throw new TypeError("workspaceRoot is required");
  const pathGuard = createWorkspacePathGuard(workspaceScope || { workspaceRoot });

  async function walk(options = {}, visitor) {
    const resolved = await pathGuard.resolve(options.cwd || ".", { mustExist: true });
    const rootStat = await fs.stat(resolved.realPath);
    if (!rootStat.isDirectory()) {
      const error = new Error("Search cwd must be a directory");
      error.statusCode = 400;
      throw error;
    }

    const excludeDirs = new Set(stringList(options.excludeDirs, DEFAULT_EXCLUDE_DIRS));
    const maxEntries = clampInt(options.maxEntries, 20_000, 1, 100_000);
    const maxDepth = clampInt(options.maxDepth, 32, 0, 128);
    const queue = [{ absolute: resolved.realPath, depth: 0 }];
    let visited = 0;
    let truncated = false;

    while (queue.length > 0) {
      const current = queue.shift();
      const children = await fs.readdir(current.absolute, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));

      for (const child of children) {
        if (visited >= maxEntries) {
          truncated = true;
          queue.length = 0;
          break;
        }
        if (child.isDirectory() && excludeDirs.has(child.name)) continue;

        const absolute = path.join(current.absolute, child.name);
        const relativeToCwd = path.relative(resolved.realPath, absolute).replace(/\\/g, "/");
        const resultPath = workspaceResultPath(resolved, absolute);
        visited += 1;

        if (child.isSymbolicLink()) {
          await visitor({
            absolute,
            relativeToCwd,
            relativeToWorkspace: resultPath.relativePath,
            ...resultPath,
            type: "symlink",
            skipped: true,
            stat: null,
          });
          continue;
        }

        const stat = await fs.stat(absolute);
        const type = child.isDirectory() ? "directory" : "file";
        const shouldContinue = await visitor({
          absolute,
          relativeToCwd,
          relativeToWorkspace: resultPath.relativePath,
          ...resultPath,
          type,
          skipped: false,
          stat,
        });
        if (shouldContinue === false) return { resolved, visited, truncated: true, excludeDirs: [...excludeDirs] };
        if (child.isDirectory() && current.depth < maxDepth) {
          queue.push({ absolute, depth: current.depth + 1 });
        }
      }
    }

    return { resolved, visited, truncated, excludeDirs: [...excludeDirs] };
  }

  async function glob(pattern, options = {}) {
    const matchers = compilePatterns(pattern || options.pattern || "**/*");
    const excludeMatchers = compilePatterns(options.exclude || [], []);
    const maxResults = clampInt(options.maxResults, 5000, 1, 20_000);
    const onlyFiles = options.onlyFiles !== false;
    const entries = [];

    const summary = await walk(options, async (entry) => {
      if (entry.skipped) return true;
      if (onlyFiles && entry.type !== "file") return true;
      if (!matchesAny(entry.relativeToCwd, matchers)) return true;
      if (excludeMatchers.length && matchesAny(entry.relativeToCwd, excludeMatchers)) return true;
      entries.push({
        workspace: entry.workspace,
        path: entry.path,
        relativePath: entry.relativePath,
        namedPath: entry.namedPath,
        type: entry.type,
        size: entry.stat.size,
        mtimeMs: entry.stat.mtimeMs,
      });
      return entries.length < maxResults;
    });

    const cwdFields = workspaceResultPath(summary.resolved);
    return {
      success: true,
      engine: "agentport-core",
      pattern: pattern || options.pattern || "**/*",
      workspace: summary.resolved.workspace,
      cwd: cwdFields.path,
      relativeCwd: cwdFields.relativePath,
      namedCwd: cwdFields.namedPath,
      entries,
      files: entries.map((entry) => entry.path),
      count: entries.length,
      truncated: summary.truncated || entries.length >= maxResults,
      maxResults,
      excludeDirs: summary.excludeDirs,
    };
  }

  async function grep(options = {}) {
    const pattern = typeof options.pattern === "string" ? options.pattern : "";
    if (!pattern) {
      const error = new Error("pattern is required");
      error.statusCode = 400;
      throw error;
    }

    const includeMatchers = compilePatterns(options.include, ["**/*"]);
    const excludeMatchers = compilePatterns(options.exclude || [], []);
    const maxResults = clampInt(options.maxResults, 200, 1, 5000);
    const maxFileBytes = clampInt(options.maxFileBytes, 1024 * 1024, 1024, 10 * 1024 * 1024);
    const caseSensitive = Boolean(options.caseSensitive);
    const useRegex = Boolean(options.regex);
    let matcher;
    if (useRegex) {
      try {
        const regex = new RegExp(pattern, caseSensitive ? "" : "i");
        matcher = (line) => regex.test(line);
      } catch (error) {
        error.statusCode = 400;
        throw error;
      }
    } else {
      const needle = caseSensitive ? pattern : pattern.toLowerCase();
      matcher = (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
    }

    const matches = [];
    let scannedFiles = 0;
    let skippedFiles = 0;
    const summary = await walk(options, async (entry) => {
      if (entry.skipped || entry.type !== "file") return true;
      if (!matchesAny(entry.relativeToCwd, includeMatchers)) return true;
      if (excludeMatchers.length && matchesAny(entry.relativeToCwd, excludeMatchers)) return true;
      if (entry.stat.size > maxFileBytes) {
        skippedFiles += 1;
        return true;
      }
      let content;
      try {
        content = await fs.readFile(entry.absolute, "utf8");
      } catch {
        skippedFiles += 1;
        return true;
      }
      if (content.includes("\u0000")) {
        skippedFiles += 1;
        return true;
      }
      scannedFiles += 1;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (!matcher(lines[i])) continue;
        matches.push({
          workspace: entry.workspace,
          path: entry.path,
          relativePath: entry.relativePath,
          namedPath: entry.namedPath,
          line: i + 1,
          text: lines[i],
        });
        if (matches.length >= maxResults) return false;
      }
      return true;
    });

    const cwdFields = workspaceResultPath(summary.resolved);
    return {
      success: true,
      engine: "agentport-core",
      pattern,
      workspace: summary.resolved.workspace,
      cwd: cwdFields.path,
      relativeCwd: cwdFields.relativePath,
      namedCwd: cwdFields.namedPath,
      include: stringList(options.include, ["**/*"]),
      excludeDirs: summary.excludeDirs,
      maxResults,
      maxFileBytes,
      caseSensitive,
      regex: useRegex,
      matches,
      truncated: summary.truncated || matches.length >= maxResults,
      scannedFiles,
      skippedFiles,
    };
  }

  return Object.freeze({ glob, grep });
}

module.exports = {
  DEFAULT_EXCLUDE_DIRS,
  createFileSearchService,
  globToRegExp,
};
