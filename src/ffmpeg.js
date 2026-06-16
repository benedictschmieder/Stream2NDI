// FFmpeg/FFprobe integration for Stream2NDI.
//
// Resolves the bundled ffmpeg/ffprobe binaries, builds the command line that
// decodes an RTSP source into a raw BGRA stream, and probes a source for its
// native resolution and frame rate.
//
// The binaries ship via the ffmpeg-static / ffprobe-static packages. When
// packaged inside an asar archive the executables must be referenced from the
// unpacked location (see asarUnpack in package.json).

const { spawn } = require("child_process");

function unpacked(p) {
  // Inside a packaged app the path points into app.asar, but a binary cannot be
  // executed from there - electron-builder unpacks it next to the archive.
  return p ? p.replace("app.asar", "app.asar.unpacked") : p;
}

function resolveFfmpegPath() {
  // ffmpeg-static exports the absolute path to the binary (or null).
  const p = require("ffmpeg-static");
  return unpacked(p);
}

function resolveFfprobePath() {
  // ffprobe-static exports { path, version }.
  const p = require("ffprobe-static").path;
  return unpacked(p);
}

// Lower-cased URL scheme (e.g. "rtsp", "rtmp"). Defaults to "rtsp" when the URL
// has no recognisable scheme so existing bare-RTSP behaviour is preserved.
function urlScheme(url) {
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(String(url || ""));
  return m ? m[1].toLowerCase() : "rtsp";
}

function isRtmp(scheme) {
  return scheme === "rtmp" || scheme === "rtmps";
}

function isRtsp(scheme) {
  return scheme === "rtsp" || scheme === "rtsps";
}

// Common input options shared by ffmpeg and ffprobe. `mode === "server"` makes
// ffmpeg passively listen on the URL and wait for a publisher to push to it;
// otherwise it actively connects (pulls) from the URL. The flags differ per
// protocol: RTSP carries its own transport/listen options, RTMP uses -listen,
// and the RTSP-only -rtsp_transport must not be passed to other demuxers.
function inputArgs(cfg) {
  const args = [];
  const scheme = urlScheme(cfg.url);
  if (isRtmp(scheme)) {
    if (cfg.mode === "server") {
      args.push("-listen", "1");
    }
  } else if (isRtsp(scheme)) {
    if (cfg.mode === "server") {
      args.push("-rtsp_flags", "listen");
    }
    args.push("-rtsp_transport", cfg.transport === "udp" ? "udp" : "tcp");
  }
  return args;
}

// Build the ffmpeg argument list that turns the RTSP source into a raw BGRA
// byte stream on stdout, scaled to exactly width x height at the given fps so
// the reader can slice fixed-size frames without any further parsing.
function buildFfmpegArgs(cfg, out) {
  const args = ["-hide_banner", "-loglevel", "warning", "-nostdin"];

  // Keep latency low: do not pre-buffer, decode as soon as packets arrive.
  args.push("-fflags", "nobuffer", "-flags", "low_delay");

  args.push(...inputArgs(cfg));
  args.push("-i", cfg.url);

  // Video only (NDI audio is out of scope for this converter).
  args.push("-an");

  // Force a known output geometry and cadence so frames are fixed-size.
  args.push("-vf", `scale=${out.width}:${out.height},format=bgra`);
  args.push("-r", String(out.fps));

  args.push("-f", "rawvideo", "-pix_fmt", "bgra", "pipe:1");
  return args;
}

// Probe an RTSP source for its native width, height and frame rate. Best-effort:
// resolves to null on any failure or timeout so the caller can fall back to
// configured/default values. Only meaningful for subscribe mode (a server-mode
// source has not connected yet, so there is nothing to probe).
function probe(cfg, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let ffprobePath;
    try {
      ffprobePath = resolveFfprobePath();
    } catch (e) {
      resolve(null);
      return;
    }

    const args = ["-v", "error"];
    // -rtsp_transport is an RTSP-only option; passing it to e.g. the RTMP
    // demuxer makes ffprobe error out, so only add it for RTSP URLs.
    if (isRtsp(urlScheme(cfg.url))) {
      args.push("-rtsp_transport", cfg.transport === "udp" ? "udp" : "tcp");
    }
    args.push(
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate",
      "-of",
      "json",
      cfg.url,
    );

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        proc.kill("SIGKILL");
      } catch (e) {
        /* ignore */
      }
      resolve(value);
    };

    let proc;
    try {
      proc = spawn(ffprobePath, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => finish(null), timeoutMs);

    let stdout = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.on("error", () => finish(null));
    proc.on("close", () => {
      try {
        const json = JSON.parse(stdout);
        const s = json.streams && json.streams[0];
        if (!s || !s.width || !s.height) return finish(null);
        const rate = parseRate(s.r_frame_rate);
        finish({
          width: Number(s.width),
          height: Number(s.height),
          frameRateN: rate ? rate.n : 0,
          frameRateD: rate ? rate.d : 0,
        });
      } catch (e) {
        finish(null);
      }
    });
  });
}

// Parse an ffprobe rational like "30000/1001" into { n, d }. Returns null for
// missing/zero rates.
function parseRate(str) {
  if (!str || typeof str !== "string") return null;
  const m = /^(\d+)\/(\d+)$/.exec(str.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const d = Number(m[2]);
  if (!n || !d) return null;
  return { n, d };
}

module.exports = {
  resolveFfmpegPath,
  resolveFfprobePath,
  buildFfmpegArgs,
  probe,
  parseRate,
};
