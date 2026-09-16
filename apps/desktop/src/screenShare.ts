import { desktopCapturer, ipcMain, session, type WebContents } from "electron";

/**
 * Screen sharing for the desktop app.
 *
 * In a browser, getDisplayMedia opens the browser's own picker. Electron has none: unless the app
 * installs a display-media handler, the request is simply denied, which is why sharing a screen
 * from the desktop app never worked. The flow here:
 *
 *   1. the renderer asks for the shareable screens and windows (`screen-share:list`),
 *   2. shows its own picker (frontend ScreenSourcePicker) and reports the choice (`screen-share:choose`),
 *   3. calls getDisplayMedia, and the handler below grants exactly that source.
 *
 * The chosen source is remembered from the listing rather than looked up again: on Wayland every
 * getSources call goes through the desktop portal's own dialog, and asking twice would make the
 * person pick twice. A choice is single-use and expires, so a stray getDisplayMedia later (or from
 * anywhere but the app's own page) gets nothing.
 */

const CHOICE_TTL_MS = 60_000;

type Listed = { id: string; name: string };
let listed = new Map<string, Listed>();
let choice: { source: Listed; at: number } | null = null;

/** Whether a URL is the app's own page. Compared by protocol and host, not `.origin`: Node's URL
 * parser does not know `app:` is a standard scheme and reports its origin as "null". */
function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "app:" && u.host === "localhost";
  } catch {
    return false;
  }
}
const fromApp = (sender: WebContents) => isAppUrl(sender.getURL());

async function listSources() {
  const options = { types: ["screen", "window"] as Array<"screen" | "window">, thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false };
  const sources = await desktopCapturer.getSources(options);
  // The X11 capturer occasionally fails to initialise on its first use and returns nothing; one
  // retry turns that into a short pause instead of "nothing to share".
  if (sources.length > 0) return sources;
  await new Promise((resolve) => setTimeout(resolve, 400));
  return desktopCapturer.getSources(options);
}

export function registerScreenShare(): void {
  ipcMain.handle("screen-share:list", async (event) => {
    if (!fromApp(event.sender)) return [];
    const sources = await listSources();
    listed = new Map(sources.map((s) => [s.id, { id: s.id, name: s.name }]));
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith("screen:") ? "screen" : "window",
      thumbnail: s.thumbnail.isEmpty() ? "" : s.thumbnail.toDataURL(),
    }));
  });

  ipcMain.handle("screen-share:choose", (event, id: unknown) => {
    if (!fromApp(event.sender) || typeof id !== "string") return false;
    const source = listed.get(id);
    if (!source) return false;
    choice = { source, at: Date.now() };
    return true;
  });

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const pending = choice;
    choice = null;
    if (!pending || Date.now() - pending.at > CHOICE_TTL_MS || !isAppUrl(request.securityOrigin)) {
      callback({});
      return;
    }
    callback({ video: pending.source });
  });
}
