import { app, BrowserWindow, protocol } from "electron";
import path from "node:path";
import fs from "node:fs";
import { contentTypeFor, resolveRendererFile } from "./protocolHandler";
import { initAutoUpdate } from "./updater";

const RENDERER_DIR = path.join(__dirname, "..", "renderer");
const isDev = !!process.env.LUMINA_DESKTOP_DEV;

// Registered before app.whenReady(), mirrors the Capacitor Android app's capacitor://localhost:
// a "standard" privileged scheme gives the renderer a real, stable Origin (app://bundle) that
// the backend's CORS_ORIGIN allowlist can match exactly (see apps/backend .env CORS_ORIGIN),
// instead of the ambiguous/frequently-null Origin behavior of loading straight from file://.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function registerAppProtocol(): void {
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const filePath = resolveRendererFile(RENDERER_DIR, url.pathname);
    return new Response(fs.readFileSync(filePath), {
      headers: { "Content-Type": contentTypeFor(filePath) },
    });
  });
}

/** Held so the updater can attach its dialog and taskbar progress to the live window without
 * either module importing the other's state. */
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#00021A",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  void win.loadURL("app://bundle/index.html");
  if (isDev) win.webContents.openDevTools({ mode: "detach" });
}

app.whenReady().then(() => {
  registerAppProtocol();
  createWindow();
  initAutoUpdate(() => mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
