// Preload for the live log viewer window. Bridges main-process log events into
// the (context-isolated) renderer via a minimal, safe API.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("logApi", {
  // Receive the buffered session history once, on open.
  onInit: (cb) => ipcRenderer.on("log:init", (_e, lines) => cb(lines)),
  // Receive each new line as it is logged.
  onLine: (cb) => ipcRenderer.on("log:line", (_e, line) => cb(line)),
});
