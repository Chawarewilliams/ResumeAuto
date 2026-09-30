/**
 * ResumeAuto Engine — Atomic Storage & Concurrency File Mutex
 * Prevents file corruption, race conditions, and dirty reads/writes.
 */

const fs = require("fs");
const path = require("path");

// Mutex queues by file path
const _fileQueues = new Map();

/**
 * Execute an operation with an exclusive file lock.
 * Ensures concurrent operations on the same file run sequentially.
 */
function withFileLock(filePath, asyncOp) {
  const resolved = path.resolve(filePath);
  let queue = _fileQueues.get(resolved);
  if (!queue) {
    queue = Promise.resolve();
    _fileQueues.set(resolved, queue);
  }

  const next = queue.then(async () => {
    return await asyncOp();
  }).catch((err) => {
    console.error(`[Storage Mutex Error on ${path.basename(resolved)}]:`, err.message);
    throw err;
  });

  _fileQueues.set(resolved, next);
  return next;
}

/**
 * Atomically writes data to a file by writing to a temporary file
 * and then atomically renaming it to the target file.
 */
function atomicWriteFileSync(filePath, data, options = "utf8") {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${resolved}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, data, options);
    fs.renameSync(tmpPath, resolved);
  } catch (err) {
    // If rename fails (e.g. cross-device on Windows or locked), fallback to direct write
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch (_) {}
    fs.writeFileSync(resolved, data, options);
  }
}

/**
 * Atomically writes a JSON object/array to disk.
 */
function atomicWriteJsonSync(filePath, data, spaces = 2) {
  const serialized = JSON.stringify(data, null, spaces);
  atomicWriteFileSync(filePath, serialized, "utf8");
}

/**
 * Safely reads a JSON file with fallback value on error or missing file.
 */
function safeReadJsonSync(filePath, fallback = null) {
  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return fallback;
    const content = fs.readFileSync(resolved, "utf8").trim();
    if (!content) return fallback;
    return JSON.parse(content);
  } catch (err) {
    console.error(`[safeReadJsonSync Warning on ${filePath}]:`, err.message);
    return fallback;
  }
}

module.exports = {
  withFileLock,
  atomicWriteFileSync,
  atomicWriteJsonSync,
  safeReadJsonSync,
};
