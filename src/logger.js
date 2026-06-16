// Simple file logger that also mirrors to the console.
//
// Writes to <userData>/logs/stream2ndi.log so the packaged (windowless) app
// leaves a trace you can inspect from the tray menu when something fails.
//
// The file is truncated on each launch and then size-rotated during a session
// (stream2ndi.log -> .1 -> .2), so a long-running autostart instance can never
// grow the logs without bound.

const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { EventEmitter } = require("events");

let logFilePath = null;
let fd = null;
let bytesWritten = 0;

// On-disk rotation: cap each file and keep a couple of rotated generations.
// Writes are synchronous (log volume is low – a health line every ~10s plus
// occasional events), which keeps rotation deterministic and race-free.
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB per file
const MAX_ROTATED_FILES = 2; // keep <log>.1 and <log>.2

// In-memory ring buffer of recent lines plus an emitter, so a live log viewer
// window can show history on open and stream new lines as they arrive.
const MAX_BUFFER = 2000;
const buffer = [];
const events = new EventEmitter();
events.setMaxListeners(0);

function init() {
  if (logFilePath) return logFilePath;
  const dir = path.join(app.getPath("userData"), "logs");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    /* ignore */
  }
  logFilePath = path.join(dir, "stream2ndi.log");
  try {
    // Truncate on each launch so the file reflects the current session.
    fd = fs.openSync(logFilePath, "w");
    bytesWritten = 0;
  } catch (e) {
    fd = null;
  }
  return logFilePath;
}

// Move a file out of the way, overwriting any existing destination. renameSync
// fails on Windows if the target exists, so unlink it first.
function safeMove(src, dst) {
  try {
    if (!fs.existsSync(src)) return;
    if (fs.existsSync(dst)) fs.unlinkSync(dst);
    fs.renameSync(src, dst);
  } catch (e) {
    /* ignore */
  }
}

// When the current file would exceed MAX_FILE_BYTES, close it, shift the
// rotated generations (.1 -> .2, current -> .1) and start a fresh file.
function rotateIfNeeded(nextLineBytes) {
  if (fd === null || !logFilePath) return;
  if (bytesWritten + nextLineBytes <= MAX_FILE_BYTES) return;
  try {
    fs.closeSync(fd);
  } catch (e) {
    /* ignore */
  }
  fd = null;
  for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
    safeMove(`${logFilePath}.${i}`, `${logFilePath}.${i + 1}`);
  }
  safeMove(logFilePath, `${logFilePath}.1`);
  try {
    fd = fs.openSync(logFilePath, "w");
    bytesWritten = 0;
  } catch (e) {
    fd = null;
  }
}

function write(level, args) {
  const line = `${new Date().toISOString()} [${level}] ${args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ")}`;
  if (fd !== null) {
    const payload = line + "\n";
    const lineBytes = Buffer.byteLength(payload);
    rotateIfNeeded(lineBytes);
    if (fd !== null) {
      try {
        fs.writeSync(fd, payload);
        bytesWritten += lineBytes;
      } catch (e) {
        /* ignore */
      }
    }
  }
  buffer.push(line);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  events.emit("line", line);
  return line;
}

// Patch console so existing console.* calls are captured to the file too.
function patchConsole() {
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  console.log = (...a) => {
    orig.log(write("info", a));
  };
  console.warn = (...a) => {
    orig.warn(write("warn", a));
  };
  console.error = (...a) => {
    orig.error(write("error", a));
  };
}

function getLogFilePath() {
  return logFilePath || init();
}

// Snapshot of the buffered session lines (oldest first).
function getBuffer() {
  return buffer.slice();
}

module.exports = { init, patchConsole, getLogFilePath, getBuffer, events };
