import { app, BrowserWindow, protocol } from "electron";
import path from "node:path";
import fs from "node:fs";
import { contentTypeFor, resolveRendererFile } from "./protocolHandler";
import { initAutoUpdate } from "./updater";

const RENDERER_DIR = path.join(__dirname, "..", "renderer");
const isDev = !!process.env.LUMINA_DESKTOP_DEV;

// Registered before app.whenReady(), mirrors the Capacitor Android app's capacitor://localhost:
// a "standard" privileged scheme gives the renderer a real, stable Origin (app://localhost) that
// the backend's CORS_ORIGIN allowlist can match exactly (see apps/backend .env CORS_ORIGIN),
// instead of the ambiguous/frequently-null Origin behavior of loading straight from file://.
//
// The host is deliberately `localhost` and not something app-specific. Cloudflare Turnstile binds a
// solved token to the page's hostname, and both the widget (against the site key's domain list) and
// the server (against TURNSTILE_HOSTNAMES) have to accept it. The old `app://bundle` presented the
// hostname "bundle", which is not a registrable domain and is in neither list - so every
// Turnstile-gated flow on desktop (signup, password reset, checkout, tips) was unsolvable. The
// Capacitor Android app already ships on `localhost` and is verified to solve, so presenting the
// same hostname here puts desktop on the identical, working footing.
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

  void win.loadURL("app://localhost/index.html");
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
