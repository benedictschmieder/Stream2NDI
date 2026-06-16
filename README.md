<p align="center">
  <img src="assets/icon.svg" width="120" alt="Stream2NDI logo" />
</p>

# Stream2NDI

> **Stream2NDI** converts RTSP and RTMP video streams into **NDI®** sources on your network. It can either **subscribe** to a stream URL (pull from a camera/encoder) or act as a **server** that a source pushes to.

> [!WARNING]
> **Disclaimer:** This app is fully vibecoded and provided as-is without warranty. Review and test it before relying on it in production.

A Windows tray tool for media production and live streaming. Point it at an RTSP or RTMP source and it appears as an NDI input in NDI-aware software (vMix, OBS with the NDI plugin, TriCaster, Wirecast, …). Each stream can run in one of two modes:

- **Subscribe** – the app connects to and pulls from a stream URL the source provides, e.g. an IP camera at `rtsp://192.168.1.50:554/stream1` or an RTMP feed at `rtmp://host/live/stream`.
- **Server** – the app listens on a URL and the source publishes to it, e.g. an encoder pushing to `rtsp://<this-pc>:8554/live` or `rtmp://<this-pc>:1935/live/stream`.

Decoding is done with a bundled, static **FFmpeg**; frames are handed to a small custom C++ N-API addon ([`native/ndi_sender.cc`](native/ndi_sender.cc)) that wraps the official NDI 6 SDK and transmits them on the LAN.

## How to use

You only need the installer (`Stream2NDI Setup x.y.z.exe`) from the [Releases page](../../releases) and the free [NDI Tools / Runtime](https://ndi.video/tools/).

**1. Install the NDI Runtime** (one-time, per machine) from https://ndi.video/tools/. This provides the NDI discovery service used by NDI receivers.

**2. Run the installer.** It's a one-click per-user installer (no admin needed) and launches automatically. It installs to `C:\Users\<you>\AppData\Local\Programs\Stream2NDI\`, with `Stream2NDI.exe` and `config.json` side by side in that folder. FFmpeg is bundled — no separate install required.

**3. Configure** either with the built-in editor — right-click the tray icon and choose **"Edit configuration…"** for a form with global defaults and one card per stream — or by editing `config.json` next to the exe directly. **Changes are applied automatically** — the app watches the file and reloads its streams a moment after you save, no restart needed.

| Field                    | Meaning                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `ndiName`                | Source name shown in your NDI receiver's source list (e.g. "Camera 1"). Must be unique per stream.                              |
| `mode`                   | `subscribe` (the app pulls from `url`) or `server` (the app listens on `url` and the source pushes to it).                      |
| `url`                    | Subscribe: the RTSP/RTMP source to connect to. Server: the address to listen on (e.g. `rtsp://0.0.0.0:8554/live` or `rtmp://0.0.0.0:1935/live/stream`). **Main setting.** |
| `transport`              | RTSP lower transport: `tcp` (reliable, default) or `udp` (lower latency, may drop on lossy networks). RTSP only; ignored for RTMP.                           |
| `width`, `height`        | Output resolution in pixels. `0` = **auto** (use the source's native size; probed in subscribe mode).                           |
| `fps`                    | Output frame rate. `0` = **auto** (use the source's native rate).                                                               |
| `reloadOnFailureSeconds` | Delay before reconnecting/relistening if the source drops or FFmpeg exits.                                                      |

Auto values fall back to **1920×1080 @ 30** when a source can't be probed (always the case in server mode, since nothing has connected yet) — set `width`/`height`/`fps` explicitly there if your source differs.

**Multiple streams.** Put several NDI sources in one config with a `streams` array. Keys outside the array act as shared defaults; each object inside `streams` is one NDI source with its own `ndiName`, `mode`, and `url`. A flat single-stream `config.json` (no `streams` array) is also accepted.

```json
{
  "transport": "tcp",
  "streams": [
    {
      "ndiName": "Camera 1",
      "mode": "subscribe",
      "url": "rtsp://192.168.1.50:554/stream1"
    },
    {
      "ndiName": "Encoder Feed",
      "mode": "server",
      "url": "rtsp://0.0.0.0:8554/live",
      "width": 1280,
      "height": 720,
      "fps": 30
    }
  ]
}
```

In the example, the second stream listens on port 8554. A source publishes to it with, for example:

```
ffmpeg -re -i input.mp4 -c copy -f rtsp rtsp://<this-pc-ip>:8554/live
```

> **Server mode** uses FFmpeg's RTSP/RTMP listener and accepts **one publisher per stream**. Make sure the chosen port is allowed through the Windows firewall.

**4. Use it in your NDI receiver** by adding an NDI input and picking the source named after your `ndiName`. (Test first with NDI Studio Monitor from NDI Tools.)

**5. Check status & logs.** The app runs in the background with a **system-tray icon**. Right-click it to see the live per-stream status (Streaming / Connecting / Error), open the **configuration editor**, or open a **live log viewer** window (real-time log with filter, wrap and autoscroll). The log viewer is the first place to look if no NDI source appears.

**6. Autostart on boot (optional).** Right-click the tray icon and tick **"Start automatically at logon"**. This adds a per-user entry that launches the app when you sign in (untick to remove it); no admin rights or scheduled tasks needed.

## How it works

A bundled static FFmpeg decodes the source into raw BGRA frames (scaled to the resolved output geometry). Stream2NDI reads those frames and re-transmits the most recent one on a steady timer through a small custom C++ N-API addon ([`native/ndi_sender.cc`](native/ndi_sender.cc)) that wraps the official NDI 6 SDK `NDIlib_send_*` API. Re-sending on a timer keeps the NDI source alive across brief network hiccups and means a receiver that connects at any moment immediately gets the current picture. (The common Node binding _grandiose_ only **receives** NDI, so sending is implemented here directly.)

## Building from source

You can build on one Windows PC and run on another — the production PC needs nothing but the NDI Runtime above.

The **build machine** must be **Windows x64** (the native addon links against the Windows NDI SDK and can't be cross-compiled) with: [Node.js 22 LTS or newer (x64)](https://nodejs.org), [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/) with the "Desktop development with C++" workload, and the [NDI 6 SDK](https://ndi.video/for-developers/ndi-sdk/) (default path `C:\Program Files\NDI\NDI 6 SDK`; set `NDI_SDK_DIR` if installed elsewhere).

```powershell
npm install        # installs Electron + FFmpeg and builds the native addon
npm start          # run in development
npm run dist       # package the Windows installer into dist\
```

`npm install` downloads the static FFmpeg/FFprobe binaries and compiles `native/ndi_sender.cc` against the Electron headers via the `install` script. Rebuild the addon alone with `npm run build:native`.

## Releases (CI)

The GitHub Actions workflow ([`.github/workflows/build-and-release.yml`](.github/workflows/build-and-release.yml)) compiles the addon and packages the installer automatically. Because the NDI SDK license forbids republishing it, the SDK is committed **encrypted** as `vendor/ndi-sdk.enc` and decrypted in CI. The blob is already committed — the only setup is adding a repository secret **`NDI_SDK_KEY`** (Settings → Secrets and variables → Actions) with the passphrase used to encrypt it.

Push a version tag to build and publish a GitHub Release with the installer attached:

```powershell
npm version patch
git push --follow-tags
```

Or run the workflow manually from the **Actions** tab to get the installer as a build artifact. To update the SDK, or to build locally, see [`vendor/README.txt`](vendor/README.txt).

## Troubleshooting

- **NDI source doesn't appear:** Confirm the NDI Runtime is installed and both machines are on the same network/VLAN with mDNS allowed; test with NDI Studio Monitor on the source PC first.
- **Subscribe stream won't connect:** Verify the RTSP URL in VLC/ffplay first. Try switching `transport` between `tcp` and `udp`. Check credentials in the URL (`rtsp://user:pass@host/…`).
- **Server stream stays "waiting for source":** Nothing has published yet. Confirm the publisher targets `rtsp://<this-pc-ip>:<port>/<path>` and that the port is open in the firewall.
- **`NDIlib_initialize() failed`:** The NDI runtime DLL is missing — install NDI Tools or copy `Processing.NDI.Lib.x64.dll` next to the exe.
- **High CPU:** Decoding/scaling high-resolution streams is CPU-heavy; set explicit `width`/`height`/`fps` to downscale, or keep `transport: tcp`.
- **Native build fails:** Ensure the C++ Build Tools workload is installed and the NDI 6 SDK exists (or set `NDI_SDK_DIR`).

## Alternative (no-code)

The same result is possible with **OBS Studio** + a **Media Source** + the **DistroAV (obs-ndi)** plugin. This project exists as a lightweight, headless, single-purpose, auto-starting converter without a full OBS install.

## License

MIT. NDI® is a registered trademark of Vizrt NDI AB. This project uses the NDI SDK under NewTek/Vizrt's license; install the SDK separately. Bundled FFmpeg binaries are distributed under their respective licenses (LGPL/GPL) by the ffmpeg-static / ffprobe-static projects.
