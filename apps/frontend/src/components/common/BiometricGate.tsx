import { useEffect, useRef, useState } from "react";
import { Fingerprint, Loader2 } from "lucide-react";
import { isBiometricLockEnabled, requestBiometricUnlock } from "../../lib/biometricLock";
import { useAuthStore } from "../../store/authStore";

/**
 * Holds the app behind a biometric prompt when the lock is on.
 *
 * Mounted above the signed-in app, and inert unless the user turned the lock on — so this renders
 * nothing at all for the overwhelming majority of sessions and on every non-native client.
 *
 * ## Locking again when the app goes to the background
 *
 * A lock that only applies at cold start is barely a lock: phones are handed over mid-session far
 * more often than they are handed over freshly booted. `visibilitychange` re-locks after the app
 * has been away for more than a moment.
 *
 * The grace period is what makes it usable. Without it, the biometric prompt ITSELF backgrounds the
 * app on some Android versions — so unlocking would immediately re-lock, and the user would be
 * stuck in a loop they cannot escape. Thirty seconds also covers the ordinary case of switching out
 * to copy a code and straight back.
 */
const RELOCK_AFTER_MS = 30_000;

export function BiometricGate({ children }: { children: React.ReactNode }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const enabled = isBiometricLockEnabled();

  const [locked, setLocked] = useState(enabled);
  const [prompting, setPrompting] = useState(false);
  const backgroundedAt = useRef<number | null>(null);

  const unlock = async () => {
    if (prompting) return;
    setPrompting(true);
    try {
      const ok = await requestBiometricUnlock("Confirm it's you to continue");
      if (ok) setLocked(false);
    } finally {
      setPrompting(false);
    }
  };

  // Prompt once on mount when locked. Not in an event handler, because the point is that the app is
  // unusable until this passes.
  useEffect(() => {
    if (enabled && locked) void unlock();
    // Intentionally runs once: re-running on every `locked` change would re-prompt immediately
    // after a cancel, which is a loop rather than a retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        backgroundedAt.current = Date.now();
        return;
      }
      const away = backgroundedAt.current ? Date.now() - backgroundedAt.current : 0;
      if (away > RELOCK_AFTER_MS) setLocked(true);
      backgroundedAt.current = null;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [enabled]);

  // Nothing to lock when nobody is signed in — the sign-in screen is its own gate.
  if (!enabled || !accessToken || !locked) return <>{children}</>;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-base-900 px-8 text-center">
      <Fingerprint className="h-10 w-10 text-accent" />
      <p className="text-sm text-signal-dim">Lumina is locked</p>
      <button
        type="button"
        onClick={() => void unlock()}
        disabled={prompting}
        className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
      >
        {prompting ? <Loader2 size={15} className="animate-spin" /> : <Fingerprint size={15} />}
        {prompting ? "Waiting…" : "Unlock"}
      </button>
      {/* A way out that does not require the biometric to work. Someone whose sensor has stopped
          reading must not be locked out of an account they know the password to. */}
      <button
        type="button"
        onClick={() => useAuthStore.getState().clear()}
        className="text-xs text-signal-faint underline hover:text-signal-dim"
      >
        Sign in with a password instead
      </button>
    </div>
  );
}
