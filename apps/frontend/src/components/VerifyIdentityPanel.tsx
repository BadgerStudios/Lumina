import { useRef, useState } from "react";
import { BadgeCheck, ShieldCheck, Loader2, Camera } from "lucide-react";
import { ApiError } from "../lib/apiClient";
import {
  useVerificationStatus,
  useStartVerification,
  useSubmitVerification,
} from "../queries/verification";

/**
 * Identity verification for the creator payout surface. Receiving real money requires a document /
 * selfie identity step (the server's requireVerifiedAdult). This panel walks the two paths:
 *  - Persona hosted flow while the monthly budget lasts (redirect to the one-time link), or
 *  - a selfie upload for admin review when Persona is at cap (`mode: "manual_review"`).
 *
 * Renders its own state from GET /verification/status, so it's safe to drop anywhere.
 */
export function VerifyIdentityPanel() {
  const { data: status, isLoading } = useVerificationStatus();
  const start = useStartVerification();
  const submitVerification = useSubmitVerification();
  const fileRef = useRef<HTMLInputElement>(null);
  const idFileRef = useRef<HTMLInputElement>(null);
  const [selfieFile, setSelfieFile] = useState<File | null>(null);
  const [idFile, setIdFile] = useState<File | null>(null);
  const [showSelfie, setShowSelfie] = useState(false);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-signal-dim">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking verification…
      </div>
    );
  }

  if (status?.identityVerified) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-base-900 px-4 py-3 text-sm text-online ring-1 ring-online/30">
        <BadgeCheck className="h-5 w-5" />
        Your identity is verified — you can receive payouts.
      </div>
    );
  }

  async function handleStart() {
    try {
      const result = await start.mutateAsync();
      if (result.mode === "persona" && result.link) {
        window.location.assign(result.link);
      } else {
        // Persona at cap (or no link) — fall back to the selfie/admin-review path.
        setShowSelfie(true);
      }
    } catch {
      /* surfaced below */
    }
  }

  // The manual path needs BOTH a selfie and an ID photo. Submitting the selfie twice would put a
  // review in the queue that a reviewer cannot actually decide, so the upload only fires once both
  // are chosen.
  async function submitBoth(nextSelfie: File | null, nextId: File | null) {
    if (!nextSelfie || !nextId) return;
    try {
      await submitVerification.mutateAsync({ selfie: nextSelfie, idDocument: nextId });
    } catch {
      /* surfaced below */
    }
  }

  const selfiePending = status?.manualReviewPending || submitVerification.isSuccess;

  return (
    <div className="rounded-lg bg-base-900 p-4 ring-1 ring-base-600">
      <div className="mb-2 flex items-center gap-2 text-signal">
        <ShieldCheck className="h-5 w-5 text-accent" />
        <span className="font-semibold">Verify your identity to receive payouts</span>
      </div>
      <p className="mb-3 text-sm text-signal-dim">
        A quick identity check is required before you can withdraw earnings — a legal requirement for
        paying creators. Your earnings keep accruing in the meantime.
      </p>

      {selfiePending ? (
        <div className="flex items-center gap-2 rounded-lg bg-base-800 px-4 py-3 text-sm text-signal-dim">
          <Loader2 className="h-4 w-4 animate-spin" />
          Your photo is with our team for review — we'll unlock payouts once it's approved.
        </div>
      ) : showSelfie ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-signal-dim">
            Add a clear selfie and a photo of a government ID so our team can confirm you're 18 or
            older. Both are deleted within 24 hours of the decision and are never shown on your
            profile.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="user"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = "";
              if (f) { setSelfieFile(f); void submitBoth(f, idFile); }
            }}
          />
          <input
            ref={idFileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = "";
              if (f) { setIdFile(f); void submitBoth(selfieFile, f); }
            }}
          />
          <button
            type="button"
            disabled={submitVerification.isPending}
            onClick={() => fileRef.current?.click()}
            className="flex items-center justify-center gap-2 rounded bg-base-700 py-2.5 font-medium text-signal hover:bg-base-600 disabled:opacity-60"
          >
            <Camera className="h-4 w-4" />
            {selfieFile ? "Selfie added — change" : "Add a selfie"}
          </button>
          <button
            type="button"
            disabled={submitVerification.isPending}
            onClick={() => idFileRef.current?.click()}
            className="flex items-center justify-center gap-2 rounded bg-base-700 py-2.5 font-medium text-signal hover:bg-base-600 disabled:opacity-60"
          >
            <Camera className="h-4 w-4" />
            {idFile ? "ID added — change" : "Add a photo of your ID"}
          </button>
          {submitVerification.isPending ? (
            <p className="text-sm text-signal-dim">Uploading…</p>
          ) : null}
          {submitVerification.isError && (
            <p className="text-sm text-dnd">
              {submitVerification.error instanceof ApiError ? submitVerification.error.message : "Upload failed — try again."}
            </p>
          )}
        </div>
      ) : (
        <>
          <button
            type="button"
            disabled={start.isPending}
            onClick={handleStart}
            className="rounded bg-accent px-4 py-2.5 font-medium text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {start.isPending ? "Starting…" : "Verify my identity"}
          </button>
          {start.isError && (
            <p className="mt-2 text-sm text-dnd">
              {start.error instanceof ApiError ? start.error.message : "Couldn't start verification — try again."}
            </p>
          )}
        </>
      )}
    </div>
  );
}
