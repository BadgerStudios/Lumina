import { app, dialog, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";

/**
 * Background auto-update for the desktop client.
 *
 * The AppImage is published to a plain static directory (`/downloads/desktop/`) alongside the
 * `latest-linux.yml` manifest electron-builder emits — the "generic" provider, i.e. no GitHub
 * Releases account, no update server to run, nothing to pay for. electron-updater fetches the
 * manifest, compares its `version` against this build's, downloads the new AppImage in the
 * background, verifies the SHA-512 recorded in the manifest, and swaps the file in place on exit.
 *
 * The install itself is deferred to quit rather than forced. Replacing the binary under a running
 * app and restarting it mid-conversation is the single most annoying thing an updater can do; the
 * user is offered a restart and, if they decline, gets the new version the next time they close
 * the app anyway.
 *
 * Deliberately silent about failures. A desktop client that cannot reach its update feed is not a
 * broken client — it is a client on a train. Errors are logged, never surfaced.
 */

/** First check is delayed so it never competes with window creation and the initial API calls. */
const FIRST_CHECK_DELAY_MS = 15_000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function initAutoUpdate(getWindow: () => BrowserWindow | null): void {
  // `isPackaged` is false under `npm run dev` and when running from source, where there is no
  // AppImage to replace and electron-updater would throw on every check.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on("error", (err) => {
    console.warn("[updater] check failed:", err?.message ?? err);
  });

  autoUpdater.on("download-progress", (progress) => {
    // Feeds the OS taskbar progress indicator — the only update UI shown while it downloads, so
    // a user who notices network activity has somewhere to see what it is.
    getWindow()?.setProgressBar(progress.percent / 100);
  });

  autoUpdater.on("update-downloaded", async (info) => {
    const win = getWindow();
    win?.setProgressBar(-1);
    if (!win) return;

    const { response } = await dialog.showMessageBox(win, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `Lumina ${info.version} has been downloaded.`,
      detail: "It will be installed the next time you close Lumina, or you can restart now.",
    });

    if (response === 0) {
      // isSilent=true, isForceRunAfter=true: no installer UI to click through, and the app comes
      // back up on its own so a restart costs the user nothing.
      autoUpdater.quitAndInstall(true, true);
    }
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch(() => {
      /* handled by the "error" listener above */
    });
  };

  setTimeout(check, FIRST_CHECK_DELAY_MS);
  setInterval(check, RECHECK_INTERVAL_MS);
}
