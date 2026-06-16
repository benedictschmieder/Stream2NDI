// Loads configuration from config.json with sensible defaults.
//
// Resolution order for the config file:
//   1. The RTSP2NDI_CONFIG environment variable (absolute path), if set.
//   2. config.json next to the packaged executable (process.resourcesPath/..).
//   3. config.json in the project root (development).
//
// The file may describe a single stream or several. All of the following are
// accepted:
//
//   // 1) Single stream (flat form)
//   { "ndiName": "...", "mode": "subscribe", "url": "rtsp://...", ... }
//
//   // 2) Multiple streams under a "streams" array. Keys outside the array act
//   //    as shared defaults for every stream.
//   { "width": 1280,
//     "streams": [ { "ndiName": "A", "url": "rtsp://..." }, ... ] }
//
//   // 3) A top-level array of stream objects.
//   [ { "ndiName": "A", "url": "rtsp://..." }, ... ]

const fs = require("fs");
const path = require("path");

// Per-stream options (each NDI source gets its own values).
//
//   mode       "subscribe" : the app connects (pulls) from the given RTSP URL.
//              "server"     : the app listens on the given RTSP URL and the
//                             video source pushes (publishes) to it.
//   transport  RTSP lower transport: "tcp" (reliable) or "udp" (lower latency).
//   width/height/fps  0 means "auto": in subscribe mode the source is probed
//                     for its native values; otherwise sensible fallbacks are
//                     used (1920x1080 @ 30). A non-zero value forces a rescale.
const STREAM_DEFAULTS = {
  ndiName: "RTSP2NDI",
  mode: "subscribe",
  url: "rtsp://127.0.0.1:8554/live",
  transport: "tcp",
  width: 0,
  height: 0,
  fps: 0,
  reloadOnFailureSeconds: 5,
};

const MODES = ["subscribe", "server"];
const TRANSPORTS = ["tcp", "udp"];

function candidatePaths() {
  const paths = [];
  if (process.env.RTSP2NDI_CONFIG) {
    paths.push(process.env.RTSP2NDI_CONFIG);
  }
  // Packaged: config.json sits next to the .exe (extraResources -> ../config.json).
  if (process.resourcesPath) {
    paths.push(path.join(process.resourcesPath, "..", "config.json"));
    paths.push(path.join(process.resourcesPath, "config.json"));
  }
  // Development: project root.
  paths.push(path.join(__dirname, "..", "config.json"));
  return paths;
}

// Resolve the config file we should read/watch: the first candidate that
// exists, or the most likely place one should live (next to the packaged exe).
function resolveConfigPath() {
  const candidates = candidatePaths();
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return candidates[candidates.length - 1] || null;
}

function sanitizeStream(raw) {
  const s = { ...STREAM_DEFAULTS, ...raw };
  s.ndiName = String(s.ndiName);
  s.mode = MODES.includes(s.mode) ? s.mode : "subscribe";
  s.url = String(s.url);
  s.transport = TRANSPORTS.includes(s.transport) ? s.transport : "tcp";
  // 0 (or invalid) means "auto"; a positive value forces that output size/rate.
  s.width = Math.max(0, Math.round(Number(s.width) || 0));
  s.height = Math.max(0, Math.round(Number(s.height) || 0));
  s.fps = Math.max(0, Math.min(120, Math.round(Number(s.fps) || 0)));
  s.reloadOnFailureSeconds = Math.max(
    1,
    Math.round(Number(s.reloadOnFailureSeconds) || 5),
  );
  return s;
}

// NDI source names must be unique on the network; suffix any duplicates.
function ensureUniqueNames(streams) {
  const counts = new Map();
  for (const s of streams) {
    const base = s.ndiName;
    if (counts.has(base)) {
      const n = counts.get(base) + 1;
      counts.set(base, n);
      const unique = `${base} ${n}`;
      console.warn(`[config] Duplicate NDI name "${base}" -> "${unique}"`);
      s.ndiName = unique;
    } else {
      counts.set(base, 1);
    }
  }
  return streams;
}

// Split a parsed config file into { appOptions, rawStreams }.
function splitConfig(raw) {
  if (Array.isArray(raw)) {
    return { appOptions: {}, rawStreams: raw };
  }
  if (raw && Array.isArray(raw.streams)) {
    const { streams, ...rest } = raw;
    return { appOptions: rest, rawStreams: streams };
  }
  // Flat single-stream object.
  return { appOptions: raw || {}, rawStreams: [raw || {}] };
}

// Read and parse the config file. Throws on JSON parse errors so callers can
// decide whether to keep the previous good config (used on live reload).
function loadConfig() {
  const configPath = resolveConfigPath();
  let raw = {};
  if (configPath && fs.existsSync(configPath)) {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }

  const { appOptions, rawStreams } = splitConfig(raw);

  // Top-level per-stream keys act as shared defaults for every stream.
  const sharedDefaults = {};
  for (const key of Object.keys(STREAM_DEFAULTS)) {
    if (appOptions[key] !== undefined) sharedDefaults[key] = appOptions[key];
  }

  let streams = rawStreams
    .filter((s) => s && typeof s === "object" && !Array.isArray(s))
    .map((s) => sanitizeStream({ ...sharedDefaults, ...s }));

  if (streams.length === 0) {
    streams = [sanitizeStream({ ...sharedDefaults })];
  }

  ensureUniqueNames(streams);

  return { configPath, streams };
}

// Per-stream keys that do not make sense as a shared/global default. Each stream
// needs its own URL, mode, and a unique NDI source name.
const PER_STREAM_ONLY_KEYS = ["url", "ndiName", "mode"];

// Keys that may be set as a global default for every stream.
const SHARED_STREAM_KEYS = Object.keys(STREAM_DEFAULTS).filter(
  (k) => !PER_STREAM_ONLY_KEYS.includes(k),
);

// Coerce a raw value to the type implied by STREAM_DEFAULTS for that key.
function coerceField(key, value) {
  const type = typeof STREAM_DEFAULTS[key];
  if (type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === "boolean") return !!value;
  return value === undefined || value === null ? undefined : String(value);
}

// Keep only the known stream keys from a raw object (drops anything the editor
// and app do not understand).
function pickStreamKeys(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const key of Object.keys(STREAM_DEFAULTS)) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

// Read the config file WITHOUT applying defaults, so the editor can distinguish
// values that were explicitly set from values that are merely inherited.
//
// Throws on JSON parse errors so the caller can surface "the current file is
// invalid" rather than silently overwriting it.
function loadRawConfig() {
  const configPath = resolveConfigPath();
  let raw = {};
  if (configPath && fs.existsSync(configPath)) {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }

  const { appOptions, rawStreams } = splitConfig(raw);
  const globalDefaults = pickStreamKeys(appOptions);
  // url/ndiName/mode are never global defaults, even in the {streams:[]} form.
  for (const key of PER_STREAM_ONLY_KEYS) delete globalDefaults[key];

  const streams = rawStreams
    .filter((s) => s && typeof s === "object" && !Array.isArray(s))
    .map(pickStreamKeys);

  return {
    configPath,
    globalDefaults,
    streams,
    builtInDefaults: STREAM_DEFAULTS,
  };
}

// Write a config object in the canonical `{streams:[]}` shape: explicit global
// defaults at the top level, then a streams array where each stream carries
// ndiName, mode, url, and only the fields it overrides. Empty/blank values are
// omitted so they fall back to the global default (or built-in).
function writeConfig(model) {
  const data = model || {};
  const out = {};

  const globalDefaults = data.globalDefaults || {};
  for (const key of SHARED_STREAM_KEYS) {
    const value = globalDefaults[key];
    if (value === undefined || value === null || value === "") continue;
    const coerced = coerceField(key, value);
    if (coerced === undefined) continue;
    // A global default equal to the built-in default is a no-op; skip it so the
    // file stays minimal.
    if (coerced === STREAM_DEFAULTS[key]) continue;
    out[key] = coerced;
  }

  out.streams = (data.streams || []).map((stream) => {
    const s = stream || {};
    const obj = {
      ndiName: String(s.ndiName == null ? "" : s.ndiName),
      mode: MODES.includes(s.mode) ? s.mode : "subscribe",
      url: String(s.url == null ? "" : s.url),
    };
    for (const key of SHARED_STREAM_KEYS) {
      const value = s[key];
      if (value === undefined || value === null || value === "") continue;
      const coerced = coerceField(key, value);
      if (coerced !== undefined) obj[key] = coerced;
    }
    return obj;
  });

  const target = resolveConfigPath();
  fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n", "utf8");
  return target;
}

module.exports = {
  loadConfig,
  loadRawConfig,
  writeConfig,
  resolveConfigPath,
  sanitizeStream,
  STREAM_DEFAULTS,
  SHARED_STREAM_KEYS,
  PER_STREAM_ONLY_KEYS,
  MODES,
  TRANSPORTS,
};
