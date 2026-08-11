import { useState } from "react";
import { Share, Plus, X } from "lucide-react";
import { shouldOfferIOSInstall } from "../../lib/iosInstall";

const DISMISS_KEY = "lumina_ios_install_dismissed_at";
/** A month. Long enough not to nag, short enough that someone who declined once but later wants
 * notifications is reminded that installing is how they get them. */
const DISMISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The iPhone install hint.
 *
 * Safari offers no install prompt of its own and exposes no API to trigger one, so the only way an
 * iPhone user learns Lumina can be a real app — and the only way they can ever receive push
 * notifications, which iOS restricts to home-screen web apps — is if the app tells them.
 *
 * Deliberately a quiet bar rather than a modal. It is a suggestion, not a demand, and an app that
 * interrupts a first-time visitor with a full-screen ask before they have seen anything is
 * describing its own priorities rather than theirs.
 */
export function IOSInstallHint() {
  const [dismissed, setDismissed] = useState(() => {
    const at = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return Date.now() - at < DISMISS_TTL_MS;
  });

  // Evaluated at render rather than in an effect: the answer cannot change during a session — a tab
  // does not become a home-screen app while running — so there is nothing to subscribe to.
  if (dismissed || !shouldOfferIOSInstall()) return null;

  return (
    <div className="flex items-start gap-3 border-b border-hairline bg-base-800 px-4 py-3 text-sm text-signal">
      <div className="min-w-0 flex-1">
        <p className="font-medium">Install Lumina on your iPhone</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-signal-dim">
          <span>Tap</span>
          <Share size={15} className="inline shrink-0" aria-label="the Share button" />
          <span>then</span>
          <span className="inline-flex items-center gap-1 rounded border border-hairline px-1.5 py-0.5 text-xs">
            <Plus size={12} /> Add to Home Screen
          </span>
        </p>
        {/* The reason, not just the instruction. "Add to Home Screen" alone reads as a bookmark
            suggestion; notifications are the thing people actually want and cannot otherwise get. */}
        <p className="mt-1.5 text-xs text-signal-faint">
          It opens without the browser bar — and it's the only way iPhone can send you notifications.
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, String(Date.now()));
          setDismissed(true);
        }}
        className="shrink-0 text-signal-faint hover:text-signal"
        aria-label="Dismiss the install suggestion"
      >
        <X size={16} />
      </button>
    </div>
  );
}
