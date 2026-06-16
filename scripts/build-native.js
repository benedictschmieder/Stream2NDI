// Builds the native NDI sender addon against the locally installed Electron
// runtime headers, so the resulting .node file loads inside Electron.
//
// Run automatically on `npm install` (postinstall) and via `npm run build:native`.

const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

function getElectronVersion() {
  try {
    return require("electron/package.json").version;
  } catch (e) {
    return null;
  }
}

// Resolve which NDI SDK to compile against. Priority:
//   1. NDI_SDK_DIR environment variable (if it contains an Include folder)
//   2. The SDK vendored into this repo at ./vendor/ndi
//   3. The default Windows install location
function resolveNdiSdkDir() {
  const envDir = process.env.NDI_SDK_DIR;
  if (envDir && fs.existsSync(path.join(envDir, "Include"))) {
    return envDir;
  }
  const vendored = path.join(__dirname, "..", "vendor", "ndi");
  if (fs.existsSync(path.join(vendored, "Include"))) {
    return vendored;
  }
  return envDir || "C:\\Program Files\\NDI\\NDI 6 SDK";
}

function main() {
  const electronVersion = getElectronVersion();

  const env = { ...process.env };
  const args = ["rebuild"];

  // Make the chosen NDI SDK location available to binding.gyp.
  const ndiSdkDir = resolveNdiSdkDir();
  env.NDI_SDK_DIR = ndiSdkDir;
  console.log(`[build-native] Using NDI SDK at: ${ndiSdkDir}`);

  if (electronVersion) {
    // Build against Electron's bundled Node headers.
    env.npm_config_runtime = "electron";
    env.npm_config_target = electronVersion;
    env.npm_config_disturl = "https://electronjs.org/headers";
    env.npm_config_arch = "x64";
    env.npm_config_target_arch = "x64";
    args.push(`--target=${electronVersion}`);
    args.push("--arch=x64");
    args.push("--dist-url=https://electronjs.org/headers");
    console.log(
      `[build-native] Building addon for Electron ${electronVersion} ...`,
    );
  } else {
    console.log(
      "[build-native] Electron not found, building for system Node.js ...",
    );
  }

  const nodeGyp = path.join(
    __dirname,
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "node-gyp.cmd" : "node-gyp",
  );

  const bin = fs.existsSync(nodeGyp) ? nodeGyp : "node-gyp";

  try {
    execFileSync(bin, args, {
      stdio: "inherit",
      env,
      shell: process.platform === "win32",
    });
  } catch (err) {
    console.error("\n[build-native] Native build failed.");
    console.error("[build-native] Make sure the following are installed:");
    console.error(
      '  - Visual Studio Build Tools with "Desktop development with C++"',
    );
    console.error("  - NDI 6 SDK (default: C:\\Program Files\\NDI\\NDI 6 SDK)");
    console.error(
      "    or set the NDI_SDK_DIR environment variable to its location.",
    );
    process.exit(1);
  }
}

main();
