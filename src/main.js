// Stream2NDI - Electron main process
//
// For each configured stream it spawns FFmpeg to decode an RTSP/RTMP source
// into raw BGRA frames and forwards them to the native NDI sender addon, which
// publishes them as an NDI video source on the network.
//
// Two ingest modes per stream:
//   subscribe : the app connects to (pulls from) the given source URL.
//   server    : the app listens on the given URL and the video source
//               pushes (publishes) to it.

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const logger = require("./logger");

// Single instance: a second launch must not fight over the NDI names/ports.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Start file logging before anything else so early failures are captured.
logger.init();
logger.patchConsole();

const {
  loadConfig,
  loadRawConfig,
  writeConfig,
  resolveConfigPath,
} = require("./config");
const ffmpeg = require("./ffmpeg");

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------
let tray = null;

// Tray icon (32px PNG, base64) generated from assets/icon.svg, embedded so the
// packaged app needs no external asset. Regenerate with scripts/make-icons.js.
const TRAY_ICON_BASE64 = require("./tray-icon");

// ---------------------------------------------------------------------------
// Load the native NDI sender addon.
// ---------------------------------------------------------------------------
function loadAddon() {
  const candidates = [
    path.join(__dirname, "..", "build", "Release", "ndi_sender.node"),
    // Packaged (asarUnpack) location.
    path.join(
      process.resourcesPath || "",
      "app.asar.unpacked",
      "build",
      "Release",
      "ndi_sender.node",
    ),
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch (err) {
      // try next
    }
  }
  throw new Error(
    'Could not load native addon ndi_sender.node. Run "npm run build:native".',
  );
}

let addon;
try {
  addon = loadAddon();
} catch (err) {
  console.error("[fatal]", err.message);
  app.quit();
  process.exit(1);
}

// Resolve the bundled ffmpeg binary once at startup so a missing/broken install
// fails loudly rather than per-stream.
let ffmpegPath = null;
try {
  ffmpegPath = ffmpeg.resolveFfmpegPath();
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    throw new Error(`ffmpeg binary not found at ${ffmpegPath}`);
  }
} catch (err) {
  console.error("[fatal] ffmpeg unavailable:", err.message);
}

// Load the initial configuration. A broken config at startup leaves the app
// running with no streams; the file watcher recovers once the file is fixed.
let appConfig;
try {
  appConfig = loadConfig();
} catch (err) {
  console.error(`[config] Failed to parse config at startup: ${err.message}`);
  appConfig = { configPath: resolveConfigPath(), streams: [] };
}

// Active streams, plus the debounce/watch state used to live-reload config.json.
let streams = [];
let configError = null; // last config-parse error message, surfaced in the tray
let watchedPath = null;
let reloadDebounce = null;
let logWin = null; // the live log viewer window, if open
let configWin = null; // the config editor window, if open

// Fallback output geometry/rate when a source cannot be probed (server mode, or
// a subscribe probe failure) and the user left the fields on "auto".
const FALLBACK_WIDTH = 1920;
const FALLBACK_HEIGHT = 1080;
const FALLBACK_FPS = 30;

// ---------------------------------------------------------------------------
// Stream: owns one FFmpeg process + NDI sender pair plus the timers that keep
// the source alive. Each configured NDI source gets its own instance.
// ---------------------------------------------------------------------------
class Stream {
  constructor(cfg) {
    this.cfg = cfg;
    this.proc = null;
    this.sender = null;
    this.senderW = 0;
    this.senderH = 0;

    // Resolved output geometry/rate (filled in start()).
    this.frameW = 0;
    this.frameH = 0;
    this.frameBytes = 0;
    this.fps = FALLBACK_FPS;
    this.ndiN = FALLBACK_FPS * 1000;
    this.ndiD = 1000;

    // Stdout frame assembly: raw BGRA arrives in arbitrary-sized chunks; we
    // buffer until a full frame (frameBytes) is available, then slice it out.
    this.chunks = [];
    this.pending = 0;

    // Latest decoded frame, re-transmitted on a steady timer so a receiver
    // connecting at any moment immediately gets the current picture and the
    // NDI source never goes stale if the network briefly stalls.
    this.lastFrame = null; // Buffer (BGRA, frameBytes long)
    this.frameTimer = null;
    this.healthTimer = null;
    this.restartTimer = null;

    this.sendCount = 0; // frames pushed to NDI in the current health window
    this.recvCount = 0; // frames decoded from ffmpeg in the current window
    this.state = "starting"; // starting | connecting | streaming | error
    this.detail = "";
    this.size = "";
    this.destroyed = false;
  }

  setStatus(state, detail) {
    this.state = state;
    if (detail !== undefined) this.detail = detail;
    updateTray();
  }

  statusLine() {
    const m = this.cfg.mode === "server" ? "\u2199 serve" : "\u2197 sub";
    switch (this.state) {
      case "streaming":
        return `\u25CF ${this.cfg.ndiName}${this.size ? " @ " + this.size : ""} (${m})`;
      case "connecting":
        return `\u25CB ${this.cfg.ndiName} \u2013 ${
          this.cfg.mode === "server"
            ? "waiting for source\u2026"
            : "connecting\u2026"
        }`;
      case "error":
        return `\u26A0 ${this.cfg.ndiName} \u2013 ${this.detail || "see log"}`;
      default:
        return `\u25CB ${this.cfg.ndiName} \u2013 starting\u2026`;
    }
  }

  ensureSender(width, height) {
    if (this.sender && width === this.senderW && height === this.senderH) {
      return;
    }
    if (this.sender) {
      try {
        this.sender.destroy();
      } catch (e) {
        /* ignore */
      }
      this.sender = null;
    }
    this.sender = new addon.NdiSender(this.cfg.ndiName);
    this.senderW = width;
    this.senderH = height;
    this.size = `${width}x${height}`;
    console.log(`[ndi] Source "${this.cfg.ndiName}" @ ${width}x${height}`);
  }

  // Decide the exact output width/height/fps before spawning ffmpeg. In
  // subscribe mode any "auto" (0) field is filled by probing the source; server
  // mode (and probe failures) fall back to sane defaults. Forcing a known size
  // lets the reader slice fixed-length frames.
  async resolveOutput() {
    const cfg = this.cfg;
    let w = cfg.width;
    let h = cfg.height;
    let fps = cfg.fps;
    let ndiN = 0;
    let ndiD = 0;

    const needsProbe =
      cfg.mode === "subscribe" && (w <= 0 || h <= 0 || fps <= 0);
    if (needsProbe) {
      console.log(`[probe] "${cfg.ndiName}" probing ${cfg.url}\u2026`);
      const info = await ffmpeg.probe(cfg);
      if (this.destroyed) return;
      if (info) {
        if (w <= 0) w = info.width;
        if (h <= 0) h = info.height;
        if (fps <= 0 && info.frameRateN) {
          ndiN = info.frameRateN;
          ndiD = info.frameRateD;
          fps = info.frameRateN / info.frameRateD;
        }
        console.log(
          `[probe] "${cfg.ndiName}" native ${info.width}x${info.height} @ ` +
            `${info.frameRateN}/${info.frameRateD}`,
        );
      } else {
        console.warn(
          `[probe] "${cfg.ndiName}" probe failed; using fallback geometry`,
        );
      }
    }

    if (w <= 0) w = FALLBACK_WIDTH;
    if (h <= 0) h = FALLBACK_HEIGHT;
    if (fps <= 0) fps = FALLBACK_FPS;
    if (!ndiN || !ndiD) {
      ndiN = Math.max(1, Math.round(fps * 1000));
      ndiD = 1000;
    }

    this.frameW = w;
    this.frameH = h;
    this.fps = fps;
    this.ndiN = ndiN;
    this.ndiD = ndiD;
    this.frameBytes = w * h * 4;
  }

  async start() {
    if (this.destroyed) return;
    if (!ffmpegPath) {
      this.scheduleRestart("ffmpeg binary unavailable");
      return;
    }
    this.setStatus("connecting");
    try {
      await this.resolveOutput();
    } catch (err) {
      this.scheduleRestart(`probe error (${err.message})`);
      return;
    }
    if (this.destroyed) return;

    const args = ffmpeg.buildFfmpegArgs(this.cfg, {
      width: this.frameW,
      height: this.frameH,
      fps: Math.round(this.fps),
    });
    console.log(
      `[ffmpeg] "${this.cfg.ndiName}" ${this.cfg.mode} ${this.cfg.url} ` +
        `-> ${this.frameW}x${this.frameH}@${Math.round(this.fps)}`,
    );

    this.chunks = [];
    this.pending = 0;

    try {
      this.proc = spawn(ffmpegPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.scheduleRestart(`spawn failed (${err.message})`);
      return;
    }

    this.proc.stdout.on("data", (chunk) => this.onData(chunk));

    // ffmpeg writes diagnostics to stderr; surface them in the log.
    this.proc.stderr.on("data", (d) => {
      const text = d.toString().trim();
      if (text) console.warn(`[ffmpeg:${this.cfg.ndiName}] ${text}`);
    });

    this.proc.on("error", (err) => {
      this.scheduleRestart(`ffmpeg error (${err.message})`);
    });

    this.proc.on("close", (code, signal) => {
      this.proc = null;
      if (this.destroyed) return;
      this.scheduleRestart(
        `ffmpeg exited (code=${code}${signal ? ` signal=${signal}` : ""})`,
      );
    });

    this.startFrameLoop();
  }

  // Assemble fixed-size BGRA frames from the raw stdout byte stream.
  onData(chunk) {
    this.chunks.push(chunk);
    this.pending += chunk.length;
    if (this.pending < this.frameBytes) return;

    const buf =
      this.chunks.length === 1
        ? this.chunks[0]
        : Buffer.concat(this.chunks, this.pending);

    let off = 0;
    while (buf.length - off >= this.frameBytes) {
      // Copy out of the shared buffer so the frame stays stable between paints.
      this.lastFrame = Buffer.from(buf.subarray(off, off + this.frameBytes));
      off += this.frameBytes;
      this.recvCount++;
      if (this.state !== "streaming") this.setStatus("streaming");
    }

    if (off < buf.length) {
      const rem = Buffer.from(buf.subarray(off));
      this.chunks = [rem];
      this.pending = rem.length;
    } else {
      this.chunks = [];
      this.pending = 0;
    }
  }

  // Transmit the most recent frame at a steady cadence (the resolved fps).
  // Sending continuously - rather than only when a new frame is decoded - means
  // a receiver that selects the source at any time immediately gets the current
  // picture instead of waiting for the next decode.
  startFrameLoop() {
    if (this.frameTimer) return;
    const intervalMs = Math.max(1, Math.round(1000 / Math.max(1, this.fps)));
    console.log(
      `[frame] "${this.cfg.ndiName}" loop started: ${Math.round(this.fps)} fps (every ${intervalMs}ms)`,
    );
    this.frameTimer = setInterval(() => {
      if (!this.lastFrame) return;
      try {
        this.ensureSender(this.frameW, this.frameH);
        this.sender.send(
          this.lastFrame,
          this.frameW,
          this.frameH,
          this.ndiN,
          this.ndiD,
        );
        this.sendCount++;
      } catch (err) {
        console.error(`[frame] "${this.cfg.ndiName}"`, err.message);
      }
    }, intervalMs);
    this.startHealthLoop();
  }

  // Periodic health line so the log shows, at a glance, that frames are still
  // flowing and how many receivers are connected.
  startHealthLoop() {
    if (this.healthTimer) return;
    const windowSecs = 10;
    this.healthTimer = setInterval(() => {
      const outFps = Math.round(this.sendCount / windowSecs);
      const inFps = Math.round(this.recvCount / windowSecs);
      this.sendCount = 0;
      this.recvCount = 0;
      if (!this.lastFrame) {
        console.warn(
          `[health] "${this.cfg.ndiName}" no frames decoded yet ` +
            `(${this.cfg.mode === "server" ? "waiting for publisher" : "connecting"})`,
        );
        return;
      }
      const receivers =
        this.sender && typeof this.sender.getConnections === "function"
          ? this.sender.getConnections()
          : "?";
      console.log(
        `[health] "${this.cfg.ndiName}" decode ${inFps} fps, ${outFps} fps to NDI, ` +
          `receivers=${receivers}, ${this.frameW}x${this.frameH}`,
      );
    }, windowSecs * 1000);
  }

  stopLoops() {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  killProc() {
    if (this.proc) {
      try {
        this.proc.kill("SIGKILL");
      } catch (e) {
        /* ignore */
      }
      this.proc = null;
    }
  }

  // Tear down the current ffmpeg process and retry after a delay. The frame loop
  // keeps re-sending the last good frame in the meantime, so a brief source
  // hiccup does not drop the NDI source.
  scheduleRestart(reason) {
    this.setStatus("error", reason);
    this.killProc();
    if (this.restartTimer || this.destroyed) return;
    const secs = Math.max(1, this.cfg.reloadOnFailureSeconds || 5);
    console.warn(
      `[restart] "${this.cfg.ndiName}" ${reason} - retrying in ${secs}s`,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.destroyed) this.start();
    }, secs * 1000);
  }

  destroy() {
    this.destroyed = true;
    this.stopLoops();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.killProc();
    if (this.sender) {
      try {
        this.sender.destroy();
      } catch (e) {
        /* ignore */
      }
      this.sender = null;
    }
    this.lastFrame = null;
    this.chunks = [];
  }
}

// ---------------------------------------------------------------------------
// Config editor window + IPC.
// ---------------------------------------------------------------------------

// Editable GUI for config.json. The renderer never touches the file directly;
// it talks to the main process over IPC (config:load / config:save), which owns
// all file access. Saving writes the canonical config and the existing file
// watcher live-reloads the running streams.
function openConfigEditor() {
  if (configWin && !configWin.isDestroyed()) {
    if (configWin.isMinimized()) configWin.restore();
    configWin.show();
    configWin.focus();
    return;
  }

  configWin = new BrowserWindow({
    width: 860,
    height: 720,
    title: "Stream2NDI \u2013 Configuration",
    backgroundColor: "#1e1e1e",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "config-editor-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  configWin.setMenuBarVisibility(false);

  configWin.on("closed", () => {
    configWin = null;
  });

  configWin.loadFile(path.join(__dirname, "config-editor.html"));
}

// IPC backing the config editor. Registered once at startup.
function registerConfigIpc() {
  ipcMain.handle("config:load", () => {
    try {
      return loadRawConfig();
    } catch (err) {
      return {
        error: err.message,
        configPath: resolveConfigPath(),
        builtInDefaults: require("./config").STREAM_DEFAULTS,
      };
    }
  });

  ipcMain.handle("config:save", (_e, model) => {
    try {
      if (
        !model ||
        !Array.isArray(model.streams) ||
        model.streams.length === 0
      ) {
        return { ok: false, error: "At least one stream is required." };
      }
      for (const s of model.streams) {
        if (!s || !String(s.url || "").trim()) {
          return { ok: false, error: "Every stream needs a URL." };
        }
        if (!String(s.ndiName || "").trim()) {
          return { ok: false, error: "Every stream needs an NDI name." };
        }
      }
      const target = writeConfig(model);
      console.log(`[config] saved from editor: ${target}`);
      return { ok: true, path: target };
    } catch (err) {
      console.error("[config] save failed:", err);
      return { ok: false, error: err.message };
    }
  });
}

// ---------------------------------------------------------------------------
// Autostart (per-user login item; no admin rights or external scripts).
// ---------------------------------------------------------------------------
function isAutoStartEnabled() {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch (e) {
    return false;
  }
}

function setAutoStart(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled });
    console.log(`[autostart] ${enabled ? "enabled" : "disabled"}`);
  } catch (e) {
    console.error("[autostart]", e.message);
  }
  updateTray();
}

// ---------------------------------------------------------------------------
// Live log viewer window.
// ---------------------------------------------------------------------------
function openLogViewer() {
  if (logWin && !logWin.isDestroyed()) {
    if (logWin.isMinimized()) logWin.restore();
    logWin.show();
    logWin.focus();
    return;
  }

  logWin = new BrowserWindow({
    width: 960,
    height: 600,
    title: "Stream2NDI \u2013 Log",
    backgroundColor: "#1e1e1e",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "log-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  logWin.setMenuBarVisibility(false);

  const wc = logWin.webContents;
  const onLine = (line) => {
    if (logWin && !logWin.isDestroyed()) wc.send("log:line", line);
  };

  wc.on("did-finish-load", () => {
    wc.send("log:init", logger.getBuffer());
    logger.events.on("line", onLine);
  });

  logWin.on("closed", () => {
    logger.events.removeListener("line", onLine);
    logWin = null;
  });

  logWin.loadFile(path.join(__dirname, "log-viewer.html"));
}

// ---------------------------------------------------------------------------
// Tray icon + status menu.
// ---------------------------------------------------------------------------
function traySummary() {
  if (configError) return `\u26A0 Config error`;
  if (streams.length === 0) return "No streams configured";
  const streaming = streams.filter((s) => s.state === "streaming").length;
  return `${streaming}/${streams.length} streaming`;
}

function updateTray() {
  if (!tray) return;
  const items = [];
  if (configError) {
    items.push({
      label: `\u26A0 Config error \u2013 ${configError}`,
      enabled: false,
    });
    items.push({ type: "separator" });
  } else if (streams.length === 0) {
    items.push({ label: "No streams configured", enabled: false });
    items.push({ type: "separator" });
  }
  streams.forEach((s) => {
    items.push({ label: s.statusLine(), enabled: false });
    items.push({ label: `    ${s.cfg.url}`, enabled: false });
  });
  if (streams.length > 0) items.push({ type: "separator" });
  items.push({ label: "Edit configuration\u2026", click: openConfigEditor });
  items.push({ label: "Open log viewer", click: openLogViewer });
  items.push({ type: "separator" });
  items.push({
    label: "Start automatically at logon",
    type: "checkbox",
    checked: isAutoStartEnabled(),
    click: (item) => {
      setAutoStart(item.checked);
    },
  });
  items.push({ label: "Quit", click: () => app.quit() });

  tray.setToolTip(`Stream2NDI \u2013 ${traySummary()}`);
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  const icon = nativeImage.createFromBuffer(
    Buffer.from(TRAY_ICON_BASE64, "base64"),
  );
  tray = new Tray(icon);
  updateTray();
}

// ---------------------------------------------------------------------------
// Stream lifecycle + live config reload.
// ---------------------------------------------------------------------------
function startStreams(cfg) {
  streams = cfg.streams.map((sc) => {
    const s = new Stream(sc);
    s.start();
    return s;
  });
  updateTray();
}

function stopStreams() {
  for (const s of streams) s.destroy();
  streams = [];
}

// Re-read config.json and rebuild all streams. On a parse error we keep the
// currently running streams and surface the problem in the tray/log, so a
// half-saved or invalid edit never takes the running service down.
function reloadConfig() {
  let next;
  try {
    next = loadConfig();
  } catch (err) {
    configError = err.message;
    console.warn(
      `[config] reload failed, keeping current streams: ${err.message}`,
    );
    updateTray();
    return;
  }
  configError = null;
  console.log(`[config] reloaded: ${next.streams.length} stream(s)`);
  appConfig = next;
  stopStreams();
  startStreams(next);
}

// Watch the config file and live-reload on change. fs.watchFile (polling) is
// used because it reliably handles editors that save atomically (write temp +
// rename) and files that appear/disappear, which fs.watch can miss.
function startConfigWatch() {
  watchedPath = appConfig.configPath;
  if (!watchedPath) {
    console.warn("[config] no config path to watch");
    return;
  }
  console.log(`[config] watching ${watchedPath}`);
  fs.watchFile(watchedPath, { interval: 1000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    if (reloadDebounce) clearTimeout(reloadDebounce);
    reloadDebounce = setTimeout(() => {
      reloadDebounce = null;
      console.log("[config] change detected, reloading");
      reloadConfig();
    }, 300);
  });
}

app.whenReady().then(() => {
  console.log(
    `[start] Stream2NDI v${app.getVersion()} (electron ${process.versions.electron})`,
  );
  console.log(`[start] ${appConfig.streams.length} stream(s)`);
  appConfig.streams.forEach((s) =>
    console.log(`[start]   - "${s.ndiName}" [${s.mode}] ${s.url}`),
  );
  console.log(`[start] ffmpeg: ${ffmpegPath || "UNAVAILABLE"}`);
  console.log(`[start] log file: ${logger.getLogFilePath()}`);
  console.log(`[start] config file: ${appConfig.configPath}`);
  if (configError) console.warn(`[start] config error: ${configError}`);
  registerConfigIpc();
  createTray();
  startStreams(appConfig);
  startConfigWatch();
});

// Tray app: stay alive even if all windows are closed.
app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  if (watchedPath) {
    try {
      fs.unwatchFile(watchedPath);
    } catch (e) {
      /* ignore */
    }
  }
  stopStreams();
});
