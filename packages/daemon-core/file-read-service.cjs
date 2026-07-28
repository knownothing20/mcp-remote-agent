const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { resolveWorkspacePath, workspaceResultPath } = require("./path-guard.cjs");
const { sha256 } = require("./atomic-write.cjs");

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function metadataEtag(stat) {
  const identity = [
    Number(stat.dev || 0),
    Number(stat.ino || 0),
    Number(stat.size || 0),
    Math.trunc(Number(stat.mtimeMs || 0)),
    Math.trunc(Number(stat.ctimeMs || 0)),
  ].join(":");
  return `meta-${sha256(Buffer.from(identity, "utf8"))}`;
}

function rangeLimitError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 413;
  Object.assign(error, details);
  return error;
}

async function readLineRangeWithHash(filePath, startLine, requestedEndLine, options = {}) {
  const maxBytes = positiveInt(options.maxBytes, 2 * 1024 * 1024, 1, 50 * 1024 * 1024);
  const maxScanBytes = positiveInt(
    options.maxScanBytes,
    Math.max(64 * 1024 * 1024, maxBytes),
    maxBytes,
    512 * 1024 * 1024,
  );
  const stream = fsSync.createReadStream(filePath, { highWaterMark: 64 * 1024 });
  const selectedLines = [];
  let selectedLineChunks = [];
  let selectedLineBytes = 0;
  let outputBytes = 0;
  let scannedBytes = 0;
  let currentLine = 1;
  let lastSelectedLine = 0;
  let reachedRequestedEnd = false;
  let reachedEof = true;

  function lineSelected() {
    return currentLine >= startLine && currentLine <= requestedEndLine;
  }

  function appendSelected(segment) {
    if (!lineSelected() || segment.length === 0) return;
    const separatorBytes = selectedLines.length > 0 ? 1 : 0;
    if (outputBytes + separatorBytes + selectedLineBytes + segment.length > maxBytes) {
      throw rangeLimitError(
        `Selected line range exceeds maxBytes ${maxBytes}; narrow the line range or use read-bytes`,
        "ERANGE_BYTES",
        { maxBytes, scannedBytes, startLine, requestedEndLine },
      );
    }
    selectedLineChunks.push(segment);
    selectedLineBytes += segment.length;
  }

  function finishCurrentLine({ advance }) {
    if (lineSelected()) {
      let line = selectedLineBytes > 0
        ? Buffer.concat(selectedLineChunks, selectedLineBytes)
        : Buffer.alloc(0);
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      const separatorBytes = selectedLines.length > 0 ? 1 : 0;
      if (outputBytes + separatorBytes + line.length > maxBytes) {
        throw rangeLimitError(
          `Selected line range exceeds maxBytes ${maxBytes}; narrow the line range or use read-bytes`,
          "ERANGE_BYTES",
          { maxBytes, scannedBytes, startLine, requestedEndLine },
        );
      }
      selectedLines.push(line.toString("utf8"));
      outputBytes += separatorBytes + line.length;
      lastSelectedLine = currentLine;
    }
    selectedLineChunks = [];
    selectedLineBytes = 0;
    if (currentLine >= requestedEndLine) return true;
    if (advance) currentLine += 1;
    return false;
  }

  outer: for await (const chunk of stream) {
    scannedBytes += chunk.length;
    if (scannedBytes > maxScanBytes) {
      throw rangeLimitError(
        `Line-range scan exceeds maxScanBytes ${maxScanBytes}; use a nearer line range or read-bytes`,
        "ESCAN_LIMIT",
        { maxScanBytes, scannedBytes, startLine, requestedEndLine },
      );
    }

    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline < 0) {
        appendSelected(chunk.subarray(offset));
        break;
      }
      appendSelected(chunk.subarray(offset, newline));
      if (finishCurrentLine({ advance: true })) {
        reachedRequestedEnd = true;
        reachedEof = false;
        break outer;
      }
      offset = newline + 1;
    }
  }

  if (!reachedRequestedEnd) finishCurrentLine({ advance: false });

  const totalLines = reachedEof ? currentLine : null;
  const actualStartLine = totalLines === null
    ? startLine
    : Math.min(startLine, Math.max(totalLines, 1));
  const actualEndLine = lastSelectedLine || actualStartLine;
  return {
    content: selectedLines.join("\n"),
    etag: options.etag || null,
    etagKind: "metadata",
    writeEtag: null,
    totalLines,
    totalLinesKnown: reachedEof,
    scannedBytes,
    maxBytes,
    maxScanBytes,
    startLine: actualStartLine,
    endLine: actualEndLine,
  };
}

function createFileReadService({ workspaceRoot, defaultMaxBytes = 2 * 1024 * 1024 } = {}) {
  if (!workspaceRoot) throw new TypeError("workspaceRoot is required");

  async function stat(inputPath) {
    const resolved = await resolveWorkspacePath(workspaceRoot, inputPath, { mustExist: true });
    const value = await fs.stat(resolved.realPath);
    return {
      ...workspaceResultPath(resolved),
      size: value.size,
      mtimeMs: value.mtimeMs,
      mode: value.mode,
      isFile: value.isFile(),
      isDirectory: value.isDirectory(),
    };
  }

  async function readText(inputPath, options = {}) {
    const resolved = await resolveWorkspacePath(workspaceRoot, inputPath, { mustExist: true });
    const value = await fs.stat(resolved.realPath);
    if (!value.isFile()) {
      const error = new Error("Target is not a file");
      error.code = "EISDIR";
      error.statusCode = 400;
      throw error;
    }

    const hasRange = options.startLine !== undefined || options.endLine !== undefined;
    const maxBytes = positiveInt(options.maxBytes, defaultMaxBytes, 1, 50 * 1024 * 1024);
    if (value.size > maxBytes && !hasRange) {
      const error = new Error(`File size ${value.size} exceeds maxBytes ${maxBytes}; use a line range or byte range`);
      error.code = "EFILESIZE";
      error.statusCode = 413;
      throw error;
    }

    if (hasRange) {
      const startLine = positiveInt(options.startLine, 1, 1);
      const requestedEndLine = positiveInt(options.endLine, Number.MAX_SAFE_INTEGER, startLine);
      const ranged = await readLineRangeWithHash(resolved.realPath, startLine, requestedEndLine, {
        maxBytes,
        maxScanBytes: options.maxScanBytes,
        etag: metadataEtag(value),
      });
      return {
        ...workspaceResultPath(resolved),
        ...ranged,
        size: value.size,
        ranged: true,
        streamed: true,
      };
    }

    const fullContent = await fs.readFile(resolved.realPath, "utf8");
    const lines = fullContent.split(/\r?\n/);
    return {
      ...workspaceResultPath(resolved),
      content: fullContent,
      etag: sha256(Buffer.from(fullContent, "utf8")),
      etagKind: "content",
      writeEtag: sha256(Buffer.from(fullContent, "utf8")),
      size: value.size,
      totalLines: lines.length,
      totalLinesKnown: true,
      startLine: 1,
      endLine: lines.length,
      ranged: false,
      streamed: false,
    };
  }

  async function readBytes(inputPath, options = {}) {
    const resolved = await resolveWorkspacePath(workspaceRoot, inputPath, { mustExist: true });
    const value = await fs.stat(resolved.realPath);
    if (!value.isFile()) {
      const error = new Error("Target is not a file");
      error.statusCode = 400;
      throw error;
    }

    const fields = workspaceResultPath(resolved);
    const offset = positiveInt(options.offset, 0, 0, value.size);
    const remaining = Math.max(0, value.size - offset);
    if (remaining === 0) {
      return {
        ...fields,
        offset,
        bytesRead: 0,
        size: value.size,
        contentBase64: "",
      };
    }
    const length = positiveInt(options.length, Math.min(64 * 1024, remaining), 1, 5 * 1024 * 1024);
    const handle = await fs.open(resolved.realPath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(length, remaining));
      const result = await handle.read(buffer, 0, buffer.length, offset);
      return {
        ...fields,
        offset,
        bytesRead: result.bytesRead,
        size: value.size,
        contentBase64: buffer.subarray(0, result.bytesRead).toString("base64"),
      };
    } finally {
      await handle.close();
    }
  }

  async function manifest(inputPath = ".", options = {}) {
    const root = await resolveWorkspacePath(workspaceRoot, inputPath, { mustExist: true });
    const rootStat = await fs.stat(root.realPath);
    if (!rootStat.isDirectory()) {
      const error = new Error("Manifest target must be a directory");
      error.statusCode = 400;
      throw error;
    }

    const maxEntries = positiveInt(options.maxEntries, 2000, 1, 20_000);
    const maxDepth = positiveInt(options.maxDepth, 8, 0, 64);
    const entries = [];
    const queue = [{ absolute: root.realPath, depth: 0 }];
    let truncated = false;

    while (queue.length > 0) {
      const current = queue.shift();
      const children = await fs.readdir(current.absolute, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));

      for (const child of children) {
        if (entries.length >= maxEntries) {
          truncated = true;
          queue.length = 0;
          break;
        }
        const absolute = path.join(current.absolute, child.name);
        const fields = workspaceResultPath(root, absolute);
        if (child.isSymbolicLink()) {
          entries.push({ ...fields, type: "symlink", skipped: true });
          continue;
        }
        const childStat = await fs.stat(absolute);
        entries.push({
          ...fields,
          type: child.isDirectory() ? "directory" : "file",
          size: childStat.size,
          mtimeMs: childStat.mtimeMs,
        });
        if (child.isDirectory() && current.depth < maxDepth) {
          queue.push({ absolute, depth: current.depth + 1 });
        }
      }
    }

    const rootFields = workspaceResultPath(root);
    return {
      workspace: root.workspace,
      root: rootFields.path,
      rootRelativePath: rootFields.relativePath,
      rootNamedPath: rootFields.namedPath,
      entries,
      count: entries.length,
      truncated,
      maxEntries,
      maxDepth,
    };
  }

  return Object.freeze({ stat, readText, readBytes, manifest });
}

module.exports = { createFileReadService, metadataEtag, readLineRangeWithHash };
