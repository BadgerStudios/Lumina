import { useEffect, useState } from "react";
import { Bell, X } from "lucide-react";
import { CLIENT_TYPE } from "../../lib/platform";
import { isWebPushSupported, subscribeToPush } from "../../lib/webPush";
import { reportError, toast } from "../../store/toastStore";

const DISMISS_KEY = "lumina.push.promptDismissedAt";
/** "Not now" means not now: ask again in two weeks, never sooner. */
const REASK_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
/** Let the page settle first; a permission question on arrival reads as spam and gets refused. */
const SHOW_AFTER_MS = 10_000;

function dismissedRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < REASK_AFTER_MS;
  } catch {
    return false;
  }
}

function rememberDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    /* private window: the bar just comes back next visit */
  }
}

/**
 * Offers browser notifications, in a browser tab only.
 *
 * Notifications in a browser used to be reachable only from Settings, and nobody found them: the
 * server had zero browser subscriptions, so a DM, a mention or a call reached a browser user only
 * while the tab was open and in front. This asks once, with the reason, behind a button (browsers,
 * iPhone in particular, only show the permission dialog from a tap).
 *
 * Never shown in the phone or desktop apps (they have their own notifications), when the browser
 * cannot do push, once permission was granted or refused, or within two weeks of "Not now".
 */
export function NotificationPrompt() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (CLIENT_TYPE || !isWebPushSupported() || Notification.permission !== "default" || dismissedRecently()) return;
    const timer = window.setTimeout(() => setShow(true), SHOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);

  if (!show) return null;

  const turnOn = async () => {
    setBusy(true);
    try {
      await subscribeToPush();
      toast.success("Notifications are on");
      setShow(false);
    } catch (err) {
      if (typeof Notification !== "undefined" && Notification.permission === "denied") {
        toast.error("Notifications are blocked for this site. You can allow them from the browser's site settings.");
        setShow(false);
      } else {
        reportError(err, "Couldn't turn on notifications");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-start gap-3 border-b border-hairline bg-base-800 px-4 py-3 text-sm text-signal">
      <Bell size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Get notified about messages and calls</p>
        <p className="mt-1 text-signal-dim">
          Lumina can tell you when someone messages, mentions or calls you, even while this tab is in the background.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void turnOn()}
            className="lx-focus rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Turning on…" : "Turn on notifications"}
          </button>
          <button
            type="button"
            onClick={() => {
              rememberDismissed();
              setShow(false);
            }}
            className="lx-focus rounded-lg px-3 py-1.5 text-xs text-signal-dim transition hover:text-signal"
          >
            Not now
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          rememberDismissed();
          setShow(false);
        }}
        className="shrink-0 text-signal-faint hover:text-signal"
        aria-label="Dismiss the notifications suggestion"
      >
        <X size={16} />
      </button>
    </div>
  );
}
