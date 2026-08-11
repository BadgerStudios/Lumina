import { useState } from "react";
import { ShieldAlert, Loader2 } from "lucide-react";
import { useBanStore } from "../store/banStore";

/**
 * Full-screen block shown to a banned user, rendered at the app root above everything else.
 *
 * Deliberately explains itself. A ban that just says "denied" is indistinguishable from the app
 * being broken, and this system matches on IP and device fingerprint — which WILL occasionally catch
 * the wrong person (shared house, office NAT, corporate-imaged laptop). The reason, the expiry and a
 * working appeal route are what make that recoverable rather than a dead end.
 */
export function BanScreen() {
  const ban = useBanStore((s) => s.ban);
  const [appeal, setAppeal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!ban) return null;

  const scopeExplanation =
    ban.scope === "DEVICE"
      ? "This device was matched to a banned account."
      : ban.scope === "IP"
        ? "This network address was matched to a banned account."
        : ban.scope === "EMAIL"
          ? "This email address was matched to a banned account."
          : "This account has been banned.";

  // A device or IP match is the case most likely to have caught the wrong person, so the appeal
  // route is signposted more prominently there.
  const collateralRisk = ban.scope === "DEVICE" || ban.scope === "IP";

  const submitAppeal = async () => {
    if (!ban.banId || appeal.trim().length < 10) return;
    setSubmitting(true);
    setError(null);
    try {
      const base = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api";
      const res = await fetch(`${base}/bans/${ban.banId}/appeal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: appeal.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "Could not submit your appeal");
      }
      setSubmitted(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const alreadyAppealed = ban.appealStatus === "PENDING";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-base-900 p-4">
      <div className="w-full max-w-lg rounded-xl border border-hairline bg-base-800 p-6">
        <div className="mb-4 flex items-center gap-3">
          <ShieldAlert className="h-8 w-8 text-flare" />
          <h1 className="font-display text-xl text-signal">Access denied</h1>
        </div>

        <p className="mb-2 text-signal-dim">{scopeExplanation}</p>

        <div className="mb-4 rounded-lg border border-hairline bg-base-900 p-3">
          <p className="text-xs uppercase tracking-wide text-signal-faint">Reason given</p>
          <p className="mt-1 text-signal">{ban.reason}</p>
          <p className="mt-2 text-xs text-signal-faint">
            {ban.expiresAt
              ? `Expires ${new Date(ban.expiresAt).toLocaleString()}`
              : "This ban does not expire automatically."}
          </p>
        </div>

        {collateralRisk && (
          <p className="mb-4 text-sm text-signal-dim">
            If you share this device or internet connection with someone else, you may have been
            caught by mistake. Appealing is the fastest way to sort that out.
          </p>
        )}

        {submitted || alreadyAppealed ? (
          <div className="rounded-lg border border-hairline bg-base-900 p-3">
            <p className="text-sm text-signal">Your appeal is with the moderation team.</p>
            <p className="mt-1 text-xs text-signal-faint">
              You'll regain access here if it's approved. There's nothing else to do for now.
            </p>
          </div>
        ) : ban.appealStatus === "DENIED" ? (
          <p className="text-sm text-signal-dim">This ban has already been appealed and upheld.</p>
        ) : ban.banId ? (
          <div className="space-y-3">
            <label className="block">
              <span className="text-sm text-signal-dim">Appeal this decision</span>
              <textarea
                value={appeal}
                onChange={(e) => setAppeal(e.target.value.slice(0, 1000))}
                rows={4}
                placeholder="Explain your side. If you think this is a mistake, say why."
                className="mt-1 w-full resize-none rounded-lg border border-hairline bg-base-700 px-3 py-2 text-sm text-signal placeholder:text-signal-faint focus:border-accent focus:outline-none"
              />
            </label>
            {error && <p className="text-sm text-flare">{error}</p>}
            <button
              type="button"
              onClick={() => void submitAppeal()}
              disabled={appeal.trim().length < 10 || submitting}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Submit appeal
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
