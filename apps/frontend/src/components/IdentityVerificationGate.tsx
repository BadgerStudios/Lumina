import { useEffect, useRef, useState } from "react";
import { Loader2, Camera, IdCard, ShieldCheck, Clock, Trash2, ExternalLink, RefreshCw } from "lucide-react";
import { ApiError } from "../lib/apiClient";
import { useAuthStore } from "../store/authStore";
import {
  useVerificationStatus,
  useSubmitVerification,
  useStartVerification,
  useDiditDecision,
  type StartVerificationResult,
} from "../queries/verification";

/**
 * Blocking age verification for new accounts.
 *
 * The server chooses the route and this screen follows it. When an automated provider is configured
 * the account is sent to Didit's hosted document + liveness check, which clears in seconds with no
 * operator involved. The selfie-and-ID upload below is the FALLBACK, shown only when no automated
 * provider answered.
 *
 * That order is the whole point. This gate previously offered the manual queue and nothing else, and
 * that queue never had a single row worked — so "verification required" silently meant "account
 * permanently unusable", and sign-ups were dead for five days before anyone noticed. A blocking gate
 * is only ever as safe as the fastest path through it.
 *
 * Not dismissible, for the same reason AgeGateModal is not: an account that has not cleared this is
 * restricted anyway, so a "later" button would leave someone quietly locked out with no explanation.
 *
 * The retention promise on this screen is a promise the SYSTEM has to keep, not marketing copy:
 * decideManualReview() stamps a deletion deadline of DOC_RETENTION_HOURS after the decision, and the
 * worker's purge sweep unlinks the files and nulls the keys. If that sweep ever stops running, this
 * screen becomes a lie — which is why the sweep logs what it clears.
 */
export function IdentityVerificationGate() {
  const user = useAuthStore((s) => s.user);
  const { data: status, isLoading } = useVerificationStatus();
  const submit = useSubmitVerification();

  const selfieRef = useRef<HTMLInputElement>(null);
  const idRef = useRef<HTMLInputElement>(null);
  const [selfie, setSelfie] = useState<File | null>(null);
  const [idDocument, setIdDocument] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useStartVerification();
  const decision = useDiditDecision();
  const [started, setStarted] = useState<StartVerificationResult | null>(null);

  // Ask the server which route this account takes, once, as soon as the gate is actually shown.
  // Guarded on `started` and on the mutation's own pending flag so a re-render cannot open a second
  // verification session — every extra call bills a session and orphans the previous one.
  const gateVisible = Boolean(user) && !isLoading && Boolean(status?.verificationRequired) && Boolean(status?.hasAgeOnRecord);
  useEffect(() => {
    if (!gateVisible || started || start.isPending) return;
    start.mutate(undefined, { onSuccess: (result) => setStarted(result) });
  }, [gateVisible, started, start]);

  // Signed in, age already answered, but identity not yet established and nothing awaiting review.
  // Accounts that are already verified, or whose submission is queued, never see this.
  if (!user || isLoading || !status) return null;
  // The server decides who this applies to, not the client: it is the only side that knows when the
  // account was created relative to when the requirement started.
  if (!status.verificationRequired) return null;
  if (!status.hasAgeOnRecord) return null; // AgeGateModal comes first — one blocking prompt at a time.

  // Automated path. Rendered as its own screen rather than woven into the upload form below,
  // because the two have nothing in common beyond the heading.
  if (started?.mode === "didit") {
    return (
      <div className="fixed inset-0 z-[94] flex items-center justify-center overflow-y-auto bg-black/85 p-4">
        <div className="my-auto w-full max-w-lg rounded-xl border border-hairline bg-base-800 p-6">
          <div className="flex items-center gap-2 text-accent">
            <ShieldCheck className="h-5 w-5" />
            <span className="font-mono text-[0.65rem] uppercase tracking-widest">Age verification</span>
          </div>
          <h2 className="mt-3 font-display text-xl text-signal">Confirm you are old enough</h2>
          <p className="mt-2 text-sm leading-relaxed text-signal-dim">
            Lumina is 18+. Scan a photo ID and take a short selfie video — it is checked
            automatically and usually finishes in under a minute.
          </p>

          <div className="mt-4 space-y-2 rounded-lg bg-base-900 p-4 text-sm text-signal-dim ring-1 ring-hairline">
            <p className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <span>
                Your documents go to our verification provider, <strong className="text-signal">not to us</strong>.
                Lumina only ever receives the decision.
              </span>
            </p>
            <p className="flex items-start gap-2">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <span>
                Come back to this tab when you are done and press{" "}
                <strong className="text-signal">I have finished</strong>.
              </span>
            </p>
          </div>

          <a
            href={started.link}
            target="_blank"
            rel="noopener noreferrer"
            className="lm-press mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 font-semibold text-white hover:bg-accent-hover"
          >
            <ExternalLink className="h-4 w-4" />
            Start verification
          </a>

          <button
            type="button"
            onClick={() => decision.mutate()}
            disabled={decision.isPending}
            className="lm-press mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-base-900 px-4 py-3 text-sm font-medium text-signal-dim ring-1 ring-hairline hover:text-signal disabled:opacity-60"
          >
            {decision.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            I have finished — check my status
          </button>

          {decision.data && !decision.data.approved ? (
            <p className="mt-3 text-center text-sm text-signal-dim">
              {decision.data.pending
                ? "Still with the provider. Give it a moment and check again."
                : `Not approved (${decision.data.status}). Contact support if you believe this is wrong.`}
            </p>
          ) : null}
          {decision.isError ? (
            <p className="mt-3 text-center text-sm text-dnd">
              Couldn&apos;t check just yet — finish the steps in the other tab first.
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  async function handleSubmit() {
    if (!selfie || !idDocument) return;
    setError(null);
    try {
      await submit.mutateAsync({ selfie, idDocument });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed. Please try again.");
    }
  }

  const ready = Boolean(selfie && idDocument) && !submit.isPending;

  return (
    <div className="fixed inset-0 z-[94] flex items-center justify-center overflow-y-auto bg-black/85 p-4">
      <div className="my-auto w-full max-w-lg rounded-xl border border-hairline bg-base-800 p-6">
        <div className="flex items-center gap-2 text-accent">
          <ShieldCheck className="h-5 w-5" />
          <span className="font-mono text-[0.65rem] uppercase tracking-widest">Age verification</span>
        </div>
        <h2 className="mt-3 font-display text-xl text-signal">Confirm you are old enough</h2>
        <p className="mt-2 text-sm leading-relaxed text-signal-dim">
          Lumina is 18+, and this part of it needs a confirmed adult. To keep that true we check by
          hand rather than taking a typed-in birthday at face value. Upload a photo of yourself and a
          photo of a government ID, and a member of our team will review them.
        </p>

        {/* The retention promise. Deliberately specific: a vague "we delete it soon" is the kind of
            claim that cannot be verified or enforced, and this one is enforced by a worker sweep. */}
        <div className="mt-4 space-y-2 rounded-lg bg-base-900 p-4 text-sm text-signal-dim ring-1 ring-hairline">
          <p className="flex items-start gap-2">
            <Trash2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <span>
              <strong className="text-signal">Both images are deleted within 24 hours</strong> of your
              account being approved or rejected. Nothing is kept beyond that.
            </span>
          </p>
          <p className="flex items-start gap-2">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <span>
              They are used <strong className="text-signal">only</strong> to confirm your age. They are
              never shown on your profile, never shared, never sold, and never used to train anything.
            </span>
          </p>
          <p className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <span>
              Only the staff reviewing your account can see them. What we keep afterwards is the
              decision itself — approved or not — never the images.
            </span>
          </p>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <FilePick
            label="Photo of you"
            hint="A clear selfie, face visible"
            icon={Camera}
            file={selfie}
            inputRef={selfieRef}
            onPick={setSelfie}
            capture="user"
          />
          <FilePick
            label="Photo of your ID"
            hint="Passport, driving licence or ID card"
            icon={IdCard}
            file={idDocument}
            inputRef={idRef}
            onPick={setIdDocument}
          />
        </div>

        <p className="mt-3 text-xs text-signal-faint">
          You may cover any part of the ID except your date of birth and photo.
        </p>

        {error ? <p className="mt-3 text-sm text-dnd">{error}</p> : null}

        <button
          onClick={() => void handleSubmit()}
          disabled={!ready}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {submit.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {submit.isPending ? "Uploading…" : "Submit for review"}
        </button>
        <p className="mt-3 text-center text-xs text-signal-faint">
          Read how this is handled in our{" "}
          <a href="/privacy" target="_blank" rel="noopener" className="underline hover:text-signal">
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </div>
  );
}

function FilePick({
  label,
  hint,
  icon: Icon,
  file,
  inputRef,
  onPick,
  capture,
}: {
  label: string;
  hint: string;
  icon: typeof Camera;
  file: File | null;
  inputRef: React.RefObject<HTMLInputElement>;
  onPick: (f: File) => void;
  capture?: "user" | "environment";
}) {
  return (
    <div>
      <button
        onClick={() => inputRef.current?.click()}
        className={`flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-3 py-5 text-center transition ${
          file ? "border-accent bg-accent/10" : "border-hairline hover:border-signal-faint"
        }`}
      >
        <Icon className={`h-6 w-6 ${file ? "text-accent" : "text-signal-faint"}`} />
        <span className="text-sm font-medium text-signal">{label}</span>
        <span className="text-xs text-signal-faint">{file ? file.name.slice(0, 28) : hint}</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        capture={capture}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
