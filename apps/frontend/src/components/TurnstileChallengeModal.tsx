import { useTurnstileChallenge } from "../store/turnstileChallengeStore";
import { Turnstile } from "./Turnstile";

/**
 * Mounted once at the app root. When a protected request comes back needing a bot check, the store
 * flips `active` and this shows the Turnstile widget in a small modal; the solved token resolves the
 * pending promise the apiClient is awaiting, which then retries the original request transparently.
 * A managed widget usually solves without interaction, so most of the time this flashes and closes.
 */
export function TurnstileChallengeModal() {
  const active = useTurnstileChallenge((s) => s.active);
  const complete = useTurnstileChallenge((s) => s.complete);

  if (!active) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-sm rounded-xl bg-base-800 p-6 text-center shadow-xl">
        <h2 className="mb-1 text-lg font-bold text-signal">Quick check</h2>
        <p className="mb-4 text-sm text-signal-dim">Confirming you're human — this only takes a moment.</p>
        <div className="flex justify-center">
          {/* Only completes on a real token; an error/expiry (empty string) just waits for a retry. */}
          <Turnstile onToken={(t) => t && complete(t)} action="challenge" />
        </div>
        <button
          type="button"
          onClick={() => complete(null)}
          className="mt-4 text-xs text-signal-faint hover:text-signal"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
