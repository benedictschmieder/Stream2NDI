// Resolves the NDI SDK location for binding.gyp at build time.
//
// This is called directly from binding.gyp so that ANY node-gyp invocation
// (npm's default rebuild, @electron/rebuild run by electron-builder, or our
// scripts/build-native.js) finds the SDK the same way, without depending on
// NDI_SDK_DIR being set by a wrapper script.
//
// Resolution priority:
//   1. NDI_SDK_DIR environment variable (if it contains an Include folder)
//   2. The SDK vendored into this repo at ./vendor/ndi
//   3. The default Windows install location
//
// Usage: node scripts/ndi-sdk-dir.js [include|lib|root]

const fs = require("fs");
const path = require("path");

function resolveNdiSdkDir() {
  const envDir = process.env.NDI_SDK_DIR;
  if (envDir && fs.existsSync(path.join(envDir, "Include"))) {
    return envDir;
  }
  const vendored = path.join(__dirname, "..", "vendor", "ndi");
  if (fs.existsSync(path.join(vendored, "Include"))) {
    return vendored;
  }
  return envDir || "C:/Program Files/NDI/NDI 6 SDK";
}

// gyp expects forward slashes even on Windows.
const dir = resolveNdiSdkDir().replace(/\\/g, "/");

switch (process.argv[2]) {
  case "include":
    process.stdout.write(dir + "/Include");
    break;
  case "lib":
    process.stdout.write(dir + "/Lib/x64/Processing.NDI.Lib.x64.lib");
    break;
  default:
    process.stdout.write(dir);
}
