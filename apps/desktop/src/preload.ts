// The renderer's only way into the desktop shell. Deliberately a script, not a module: with
// `sandbox: true` a preload runs with a restricted require and no CommonJS `exports`, so an
// `import`/`export` here (which tsc turns into `Object.defineProperty(exports, …)`) would throw
// before anything is exposed.
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

/**
 * Screen sharing. Chromium's getDisplayMedia has no picker inside Electron: the main process has to
 * grant a specific source, and before this existed every "Share your screen" click was refused.
 * The app lists the screens and windows, shows its own picker, tells the shell which one was
 * chosen, and only then calls getDisplayMedia. See screenShare.ts for the main-process half.
 */
contextBridge.exposeInMainWorld("luminaDesktop", {
  listScreenSources: () => ipcRenderer.invoke("screen-share:list"),
  chooseScreenSource: (id: string) => ipcRenderer.invoke("screen-share:choose", id),
});
