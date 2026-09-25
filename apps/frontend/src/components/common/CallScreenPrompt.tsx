import { useEffect, useState } from "react";
import { PhoneCall, X } from "lucide-react";
import { APP_VARIANT, CLIENT_TYPE } from "../../lib/platform";
import { fullScreenCallsAllowed, openFullScreenCallSettings } from "../../lib/nativeVoiceCall";

const DISMISS_KEY = "lumina.calls.fullScreenPromptDismissedAt";
const REASK_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

function dismissedRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < REASK_AFTER_MS;
  } catch {
    return false;
  }
}

/**
 * Asks, once, to let incoming calls take over a locked screen.
 *
 * From Android 14 a sideloaded app may not show a full-screen call by default: a call to a locked
 * phone still rings, but only as a notification at the top, with the screen left dark. The setting
 * is one switch in the app's system settings, and only the person can turn it on. Phone app only,
 * never where it is already allowed, and "Not now" holds for 30 days.
 */
export function CallScreenPrompt() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (CLIENT_TYPE !== "mobile" || APP_VARIANT === "owner" || dismissedRecently()) return;
    let cancelled = false;
    const check = () =>
      void fullScreenCallsAllowed().then((allowed) => {
        if (!cancelled) setShow(allowed === false);
      });
    const timer = window.setTimeout(check, 8_000);
    // Coming back from the system settings page is when the answer changes.
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* the prompt just comes back next launch */
    }
    setShow(false);
  };

  return (
    <div className="flex items-start gap-3 border-b border-hairline bg-base-800 px-4 py-3 text-sm text-signal">
      <PhoneCall size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Show calls on your lock screen</p>
        <p className="mt-1 text-signal-dim">
          Android only shows an incoming call as a small notification until you let Lumina use the full screen for calls.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void openFullScreenCallSettings()}
            className="lx-focus rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
          >
            Open settings
          </button>
          <button type="button" onClick={dismiss} className="lx-focus rounded-lg px-3 py-1.5 text-xs text-signal-dim transition hover:text-signal">
            Not now
          </button>
        </div>
      </div>
      <button type="button" onClick={dismiss} className="shrink-0 text-signal-faint hover:text-signal" aria-label="Dismiss the call screen suggestion">
        <X size={16} />
      </button>
    </div>
  );
}
