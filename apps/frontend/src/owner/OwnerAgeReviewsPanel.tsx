import { useEffect, useState } from "react";
import { Loader2, Check, X } from "lucide-react";
import { useAgeReviews, useDecideAgeReview, type AgeReview } from "../queries/verification";
import { useAuthStore } from "../store/authStore";
import { resolveAssetUrl } from "../lib/apiClient";
import { Group, EmptyState } from "./OwnerChrome";

/**
 * The Persona-cap fallback queue: users who submitted a selfie for manual age review. An admin sees
 * the selfie next to the self-declared birthday and decides 18+ (approve → identity verified, payouts
 * unlocked) or under-18 (reject → account locked as a minor). The selfie is purged on decision.
 */
export function OwnerAgeReviewsPanel() {
  const { data: reviews, isLoading } = useAgeReviews();
  const decide = useDecideAgeReview();

  return (
    <div className="space-y-5">
      <Group label={`Pending selfie reviews${reviews ? ` — ${reviews.length}` : ""}`}>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
          </div>
        ) : !reviews || reviews.length === 0 ? (
          <EmptyState title="Nothing to review" hint="Selfie age reviews appear here when Persona is at its monthly cap." />
        ) : (
          <div className="space-y-3">
            {reviews.map((r) => (
              <ReviewCard
                key={r.id}
                review={r}
                deciding={decide.isPending}
                onDecide={(decision) => decide.mutate({ id: r.id, decision })}
              />
            ))}
          </div>
        )}
      </Group>
    </div>
  );
}

function ReviewCard({
  review,
  deciding,
  onDecide,
}: {
  review: AgeReview;
  deciding: boolean;
  onDecide: (decision: "ADULT" | "MINOR") => void;
}) {
  const claimedDob = review.user.birthDate ? new Date(review.user.birthDate) : null;
  const claimedAge = claimedDob ? Math.floor((Date.now() - claimedDob.getTime()) / (365.25 * 24 * 3600 * 1000)) : null;

  return (
    <div className="oc-panel overflow-hidden p-3">
      <div className="flex gap-3">
        <AuthedImage url={review.selfieUrl} alt="Selfie for review" />
        {/* The ID photo is the half that actually carries a date of birth — a selfie alone cannot
            settle an age question, so both are shown side by side. */}
        <AuthedImage url={review.idDocumentUrl} alt="ID document for review" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-signal">
            @{review.user.username}
            {review.user.displayName ? <span className="text-signal-faint"> · {review.user.displayName}</span> : null}
          </p>
          <p className="mt-1 text-xs text-signal-dim">
            Self-declared: {review.user.ageBracket ?? "—"}
            {claimedAge != null ? ` · about ${claimedAge}` : ""}
          </p>
          <p className="mt-0.5 text-[10px] text-signal-faint">
            Submitted {new Date(review.createdAt).toLocaleString()}
          </p>

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={deciding}
              onClick={() => onDecide("ADULT")}
              className="flex items-center gap-1.5 rounded bg-online/15 px-3 py-1.5 text-xs font-medium text-online ring-1 ring-online/30 hover:bg-online/25 disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" /> Approve — 18+
            </button>
            <button
              type="button"
              disabled={deciding}
              onClick={() => onDecide("MINOR")}
              className="flex items-center gap-1.5 rounded bg-flare/15 px-3 py-1.5 text-xs font-medium text-flare ring-1 ring-flare/30 hover:bg-flare/25 disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" /> Reject — under 18
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The selfie route is Bearer-authenticated (owner-only), so a plain <img src> — which sends no auth
 * header — would 401. Fetch the image with the access token and render it as an object URL, revoked
 * on unmount so the sensitive image doesn't linger.
 */
function AuthedImage({ url, alt }: { url: string | null; alt: string }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!url) return;
    let revoked = false;
    let created: string | null = null;
    const token = useAuthStore.getState().accessToken;
    // resolveAssetUrl: the server returns a root-relative "/api/..." URL, but the owner console runs
    // as a WebView whose API is a DIFFERENT origin — a bare "/api/..." fetch would resolve against
    // capacitor://localhost and 404, so admins would review every selfie blind. Same reason
    // apiClient rewrites asset URLs.
    fetch(resolveAssetUrl(url), { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.blob();
      })
      .then((blob) => {
        if (revoked) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch(() => setFailed(true));
    return () => {
      revoked = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [url]);

  if (failed || !url) {
    return <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-lg bg-base-700 text-[10px] text-signal-faint">no image</div>;
  }
  if (!objectUrl) {
    return (
      <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-lg bg-base-700">
        <Loader2 className="h-4 w-4 animate-spin text-signal-faint" />
      </div>
    );
  }
  return <img src={objectUrl} alt={alt} className="h-24 w-24 shrink-0 rounded-lg object-cover" />;
}
