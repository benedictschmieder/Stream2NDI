#!/usr/bin/env node
//
// crypt-ndi.js — encrypt/decrypt the NDI SDK so it can live in a PUBLIC repo
// without redistributing the SDK in usable form.
//
// The NDI SDK license does not allow republishing the SDK openly. Instead we
// commit only an AES-256-GCM encrypted blob (vendor/ndi-sdk.enc). CI decrypts
// it at build time using the NDI_SDK_KEY secret. Only key holders can use it,
// so the SDK is not "made available" to the public.
//
// Usage:
//   Set a passphrase first:
//     PowerShell:  $env:NDI_SDK_KEY = "your-strong-passphrase"
//     bash:        export NDI_SDK_KEY="your-strong-passphrase"
//
//   Encrypt a folder (its contents become vendor/ndi after decryption):
//     node scripts/crypt-ndi.js encrypt <sourceDir> [vendor/ndi-sdk.enc]
//
//   Decrypt (used by CI, and locally before `npm run dist`):
//     node scripts/crypt-ndi.js decrypt [vendor/ndi-sdk.enc] [vendor/ndi]
//
// The <sourceDir> must contain the NDI SDK files in this layout:
//     Include/Processing.NDI.Lib.h        (+ the other headers)
//     Lib/x64/Processing.NDI.Lib.x64.lib
//     Bin/x64/Processing.NDI.Lib.x64.dll

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAGIC = Buffer.from("NDIENC01");

function getPassphrase() {
  const pass = process.env.NDI_SDK_KEY;
  if (!pass || !pass.trim()) {
    console.error(
      "[crypt-ndi] Set the NDI_SDK_KEY environment variable to your passphrase."
    );
    process.exit(1);
  }
  return pass;
}

// --- Minimal dependency-free archive (length-prefixed files) ---------------

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, out);
    } else if (entry.isFile()) {
      out.push({
        rel: path.relative(base, full).split(path.sep).join("/"),
        full,
      });
    }
  }
  return out;
}

function packDir(srcDir) {
  const files = walk(srcDir, srcDir, []);
  if (files.length === 0) {
    console.error(`[crypt-ndi] No files found under ${srcDir}`);
    process.exit(1);
  }
  const chunks = [];
  const count = Buffer.alloc(4);
  count.writeUInt32BE(files.length);
  chunks.push(count);
  for (const f of files) {
    const data = fs.readFileSync(f.full);
    const relBuf = Buffer.from(f.rel, "utf8");
    const relLen = Buffer.alloc(4);
    relLen.writeUInt32BE(relBuf.length);
    const dataLen = Buffer.alloc(8);
    dataLen.writeBigUInt64BE(BigInt(data.length));
    chunks.push(relLen, relBuf, dataLen, data);
  }
  console.log(`[crypt-ndi] Packed ${files.length} file(s) from ${srcDir}`);
  return Buffer.concat(chunks);
}

function unpackDir(buf, destDir) {
  let o = 0;
  const count = buf.readUInt32BE(o);
  o += 4;
  for (let i = 0; i < count; i++) {
    const relLen = buf.readUInt32BE(o);
    o += 4;
    const rel = buf.subarray(o, o + relLen).toString("utf8");
    o += relLen;
    const dataLen = Number(buf.readBigUInt64BE(o));
    o += 8;
    const data = buf.subarray(o, o + dataLen);
    o += dataLen;
    const dest = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  console.log(`[crypt-ndi] Restored ${count} file(s) to ${destDir}`);
}

// --- Encryption ------------------------------------------------------------

function encrypt(plaintext) {
  const pass = getPassphrase();
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, enc]);
}

function decrypt(blob) {
  const pass = getPassphrase();
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Not a valid NDIENC01 blob");
  }
  let o = MAGIC.length;
  const salt = blob.subarray(o, (o += 16));
  const iv = blob.subarray(o, (o += 12));
  const tag = blob.subarray(o, (o += 16));
  const enc = blob.subarray(o);
  const key = crypto.scryptSync(pass, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

// --- CLI -------------------------------------------------------------------

function main() {
  const [, , mode, arg1, arg2] = process.argv;

  if (mode === "encrypt") {
    const srcDir = arg1;
    const outFile = arg2 || path.join("vendor", "ndi-sdk.enc");
    if (!srcDir || !fs.existsSync(srcDir)) {
      console.error("[crypt-ndi] encrypt <sourceDir> [outFile]");
      process.exit(1);
    }
    const blob = encrypt(packDir(srcDir));
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, blob);
    console.log(`[crypt-ndi] Wrote encrypted blob: ${outFile}`);
  } else if (mode === "decrypt") {
    const inFile = arg1 || path.join("vendor", "ndi-sdk.enc");
    const destDir = arg2 || path.join("vendor", "ndi");
    if (!fs.existsSync(inFile)) {
      console.error(`[crypt-ndi] Blob not found: ${inFile}`);
      process.exit(1);
    }
    try {
      unpackDir(decrypt(fs.readFileSync(inFile)), destDir);
    } catch (err) {
      console.error(
        `[crypt-ndi] Decryption failed: ${err.message}\n` +
          "Check that NDI_SDK_KEY matches the passphrase used to encrypt."
      );
      process.exit(1);
    }
  } else {
    console.error(
      "Usage:\n" +
        "  node scripts/crypt-ndi.js encrypt <sourceDir> [vendor/ndi-sdk.enc]\n" +
        "  node scripts/crypt-ndi.js decrypt [vendor/ndi-sdk.enc] [vendor/ndi]"
    );
    process.exit(1);
  }
}

main();
