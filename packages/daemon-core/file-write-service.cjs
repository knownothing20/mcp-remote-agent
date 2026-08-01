const fs = require("node:fs/promises");
const { createWorkspacePathGuard, workspaceResultPath } = require("./path-guard.cjs");
const { atomicWriteFile, sha256 } = require("./atomic-write.cjs");
const { createKeyLock } = require("./key-lock.cjs");

async function readCurrentEtag(filePath) {
  try {
    const content = await fs.readFile(filePath);
    return sha256(content);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function conflict(message, currentEtag = null) {
  const error = new Error(message);
  error.code = "EWRITE_CONFLICT";
  error.statusCode = 409;
  error.currentEtag = currentEtag;
  return error;
}

function createFileWriteService({ workspaceRoot, workspaceScope } = {}) {
  if (!workspaceRoot) throw new TypeError("workspaceRoot is required");
  const pathGuard = createWorkspacePathGuard(workspaceScope || { workspaceRoot });
  const locks = createKeyLock();

  async function writeText(inputPath, content, options = {}) {
    if (typeof content !== "string") {
      const error = new TypeError("content must be a string");
      error.statusCode = 400;
      throw error;
    }

    const resolved = await pathGuard.resolve(inputPath, { mustExist: false });
    return locks.withLock(resolved.path, async () => {
      const currentEtag = await readCurrentEtag(resolved.path);
      const expectedEtag = String(options.expectedEtag || "").trim();
      if (expectedEtag && expectedEtag !== currentEtag) {
        throw conflict("Write conflict: expectedEtag mismatch", currentEtag);
      }
      if (options.createOnly && currentEtag) {
        throw conflict("Write conflict: target already exists", currentEtag);
      }

      let existingMode = null;
      try {
        const existingStat = await fs.stat(resolved.path);
        existingMode = existingStat.mode & 0o777;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const requestedMode = options.mode === undefined || options.mode === null
        ? (existingMode ?? 0o644)
        : Number(options.mode);

      const result = await atomicWriteFile(resolved.path, content, {
        encoding: "utf8",
        mode: requestedMode,
      });
      const readback = await fs.readFile(resolved.path);
      const readbackEtag = sha256(readback);
      if (readbackEtag !== result.sha256) {
        const error = new Error("Write verification failed");
        error.code = "EWRITE_VERIFY";
        error.statusCode = 500;
        throw error;
      }

      return {
        success: true,
        ...workspaceResultPath(resolved, resolved.path),
        etag: readbackEtag,
        previousEtag: currentEtag,
        bytes: result.bytes,
        atomic: true,
        verified: true,
      };
    });
  }

  async function removeFile(inputPath, options = {}) {
    const resolved = await pathGuard.resolve(inputPath, { mustExist: true });
    return locks.withLock(resolved.realPath, async () => {
      const value = await fs.lstat(resolved.realPath);
      if (!value.isFile()) {
        const error = new Error("Only regular files can be removed through removeFile");
        error.statusCode = 400;
        throw error;
      }
      const currentEtag = await readCurrentEtag(resolved.realPath);
      const expectedEtag = String(options.expectedEtag || "").trim();
      if (expectedEtag && expectedEtag !== currentEtag) {
        throw conflict("Delete conflict: expectedEtag mismatch", currentEtag);
      }
      const fields = workspaceResultPath(resolved, resolved.realPath);
      await fs.rm(resolved.realPath);
      return {
        success: true,
        ...fields,
        previousEtag: currentEtag,
      };
    });
  }

  return Object.freeze({ writeText, removeFile, activeLocks: locks.size });
}

module.exports = { createFileWriteService };
