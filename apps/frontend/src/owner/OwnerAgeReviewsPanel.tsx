import { useEffect, useState } from "react";
import { Loader2, Check, X } from "lucide-react";
import { useAgeReviews, useDecideAgeReview, type AgeReview } from "../queries/verification";
import { useAuthStore } from "../store/authStore";
import { isOwner } from "../lib/platformRole";
import { resolveAssetUrl } from "../lib/apiClient";
import { Group, EmptyState, Badge, DataList, DataRow } from "./OwnerChrome";
import { useAgeQueue, useDecideHeldSignup, useResolveFlag, type AgeQueuePending, type AgeQueueRefused } from "../queries/owner";
import { useConfirm } from "../components/common/ConfirmDialog";
import { relativeTime } from "../lib/relativeTime";
import { FlagProvenance, UserProvenance, ageLabel } from "./OwnerProvenance";

/**
 * Everything waiting on an age decision.
 *
 *  - Held sign-ups (owner decision 2026-10-01): an under-18 answer, or an adult age range with a
 *    birth date under 13 (nearly always a typo). The account exists but can't sign in until the
 *    owner approves or denies it. Deny deletes it and puts the device on the under-age cooldown.
 *  - Selfie reviews: the Persona-cap fallback for identity verification.
 *  - Refused sign-ups: self-declared under 13, refused outright - shown with where they came from.
 */
export function OwnerAgeReviewsPanel() {
  const { data: reviews, isLoading } = useAgeReviews();
  const decide = useDecideAgeReview();
  const queue = useAgeQueue();
  const { confirm: confirmSelfie } = useConfirm();

  return (
    <div className="space-y-5">
      <Group label={`Waiting for your approval${queue.data ? ` — ${queue.data.pending.length}` : ""}`}>
        {queue.isLoading ? (
          <Spinner />
        ) : queue.error ? (
          <EmptyState title="Couldn't load the age queue" hint={(queue.error as Error).message} />
        ) : !queue.data || queue.data.pending.length === 0 ? (
          <EmptyState title="No sign-ups waiting" hint="Under-18 sign-ups, and adult ones whose birth date says under 13, wait here for you." />
        ) : (
          <div className="space-y-3">
            {queue.data.pending.map((p) => (
              <HeldSignupCard key={p.id} signup={p} />
            ))}
          </div>
        )}
      </Group>

      <Group label={`Pending selfie reviews${reviews ? ` — ${reviews.length}` : ""}`}>
        {isLoading ? (
          <Spinner />
        ) : !reviews || reviews.length === 0 ? (
          <EmptyState title="Nothing to review" hint="Selfie age reviews appear here when Persona is at its monthly cap." />
        ) : (
          <div className="space-y-3">
            {reviews.map((r) => (
              <ReviewCard
                key={r.id}
                review={r}
                deciding={decide.isPending}
                onDecide={async (decision) => {
                  if (
                    decision === "MINOR" &&
                    !(await confirmSelfie({
                      title: `Make @${r.user.username} a minor account?`,
                      description:
                        "Adult spaces close and contact with adults is walled. The account stays locked until a parent or guardian accepts it.",
                      confirmText: "Make minor account",
                      danger: true,
                    }))
                  )
                    return;
                  decide.mutate({ id: r.id, decision });
                }}
              />
            ))}
          </div>
        )}
      </Group>

      {queue.data && queue.data.refused.length > 0 && (
        <Group label={`Refused, mismatched & denied sign-ups, last 90 days — ${queue.data.refused.length}`}>
          <div className="space-y-2">
            {queue.data.refused.map((f) => (
              <RefusedRow key={f.id} flag={f} />
            ))}
          </div>
        </Group>
      )}

      {queue.data && queue.data.decided.length > 0 && (
        <Group label="Recently approved">
          <DataList>
            {queue.data.decided.map((d) => (
              <DataRow
                key={d.id}
                title={`@${d.username}`}
                subtitle={`${d.minor ? "Minor account" : "Adult account"}${d.reason ? ` · ${d.reason}` : ""}`}
                meta={d.decidedAt ? relativeTime(d.decidedAt) : undefined}
              />
            ))}
          </DataList>
        </Group>
      )}
    </div>
  );
}

function RefusedRow({ flag: f }: { flag: AgeQueueRefused }) {
  const resolve = useResolveFlag();
  const { confirm } = useConfirm();
  const blocks = f.reasonCode === "AGE_UNDER_MINIMUM" || f.reasonCode === "AGE_SIGNUP_COOLDOWN";
  const label =
    f.reasonCode === "AGE_SIGNUP_COOLDOWN"
      ? "Denied by you"
      : f.reasonCode === "AGE_UNDER_MINIMUM"
        ? f.heldForReview
          ? "Birth date under 13 (held)"
          : "Under 13 — refused"
        : "Age mismatch";
  return (
    <div className="oc-panel space-y-1.5 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm text-signal">
        <Badge tone={f.reasonCode === "AGE_MISMATCH" ? undefined : "bad"}>{label}</Badge>
        <span className="text-xs text-signal-faint">{relativeTime(f.createdAt)}</span>
        {!f.active && <span className="text-xs text-signal-faint">· {blocks ? "cooldown lifted" : "reviewed"}</span>}
        {f.active && (
          <button
            type="button"
            disabled={resolve.isPending}
            onClick={async () => {
              if (
                blocks &&
                !(await confirm({
                  title: "Lift this device's sign-up cooldown?",
                  description: "The device this came from can sign up again straight away instead of waiting out the 30 days.",
                  confirmText: "Lift cooldown",
                }))
              )
                return;
              resolve.mutate({ flagId: f.id });
            }}
            className="ml-auto rounded px-2 py-0.5 text-[11px] text-signal-faint ring-1 ring-hairline hover:text-signal disabled:opacity-50"
          >
            {blocks ? "Lift cooldown" : "Mark reviewed"}
          </button>
        )}
      </div>
      {f.detail && <p className="text-xs text-signal-dim">{f.detail}</p>}
      {f.device && (
        <p className="text-xs text-signal-faint">
          {f.device}
          {f.country ? ` · ${f.country}` : ""}
        </p>
      )}
      {f.hasProvenance && <FlagProvenance flagId={f.id} />}
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex justify-center py-8">
      <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
    </div>
  );
}

function HeldSignupCard({ signup }: { signup: AgeQueuePending }) {
  const decide = useDecideHeldSignup();
  const { confirm } = useConfirm();
  // The decision is the owner's (POST /owner/age-queue/:id/decide is requireOwner); an admin sees
  // the queue but not buttons that would only 403.
  const canDecide = isOwner(useAuthStore((st) => st.user?.platformRole));
  const contradiction = (signup.reason ?? "").startsWith("Picked ");

  async function run(decision: "APPROVE" | "DENY") {
    const ok = await confirm(
      decision === "APPROVE"
        ? {
            title: `Approve @${signup.username}?`,
            description: contradiction
              ? "They picked an adult age range. Approving opens the account as an adult and clears the birth date that didn't match."
              : "This opens it as a minor account: adult spaces closed, contact with adults walled, and it stays locked until a parent or guardian accepts it with the pairing code shown in their Settings. They'll get an email saying they can sign in.",
            confirmText: "Approve",
          }
        : {
            title: `Deny @${signup.username}?`,
            description:
              "The account and everything entered is deleted, the device goes on the 30-day sign-up cooldown, and they get an email saying it wasn't approved. This can't be undone.",
            confirmText: "Deny and delete",
            danger: true,
          },
    );
    if (ok) decide.mutate({ userId: signup.id, decision });
  }

  return (
    <div className="oc-panel space-y-2 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <p className="truncate text-sm text-signal">@{signup.username}</p>
        {signup.displayName && <p className="truncate text-xs text-signal-faint">{signup.displayName}</p>}
        <span className="ml-auto text-[10px] text-signal-faint">signed up {relativeTime(signup.createdAt)}</span>
      </div>
      <p className="text-xs text-signal">{signup.reason ?? "Held for age review"}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-signal-faint">Age given</dt>
        <dd className="text-signal-dim">
          {ageLabel(signup.ageBracket)}
          {signup.birthDate ? ` · born ${signup.birthDate}` : ""}
        </dd>
        <dt className="text-signal-faint">Device</dt>
        <dd className="text-signal-dim">
          {signup.device}
          {signup.country ? ` · ${signup.country}` : ""}
        </dd>
        <dt className="text-signal-faint">Email</dt>
        <dd className="truncate text-signal-dim">{signup.email}</dd>
        {signup.otherAccountsOnDevice > 0 && (
          <>
            <dt className="text-signal-faint">Same device</dt>
            <dd className="text-signal-dim">{signup.otherAccountsOnDevice} other account(s) have signed in on it</dd>
          </>
        )}
      </dl>
      <UserProvenance userId={signup.id} />
      {!canDecide ? (
        <p className="pt-1 text-xs text-signal-faint">Waiting for the owner to approve or deny.</p>
      ) : (
      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          disabled={decide.isPending}
          onClick={() => void run("APPROVE")}
          className="flex items-center gap-1.5 rounded bg-online/15 px-3 py-1.5 text-xs font-medium text-online ring-1 ring-online/30 hover:bg-online/25 disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" /> {contradiction ? "Approve as adult" : "Approve as minor account"}
        </button>
        <button
          type="button"
          disabled={decide.isPending}
          onClick={() => void run("DENY")}
          className="flex items-center gap-1.5 rounded bg-flare/15 px-3 py-1.5 text-xs font-medium text-flare ring-1 ring-flare/30 hover:bg-flare/25 disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" /> Deny
        </button>
      </div>
      )}
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
  onDecide: (decision: "ADULT" | "MINOR") => void | Promise<void>;
}) {
  const claimedDob = review.user.birthDate ? new Date(review.user.birthDate) : null;
  const claimedAge = claimedDob ? Math.floor((Date.now() - claimedDob.getTime()) / (365.25 * 24 * 3600 * 1000)) : null;

  return (
    <div className="oc-panel overflow-hidden p-3">
      <div className="flex gap-3">
        <AuthedImage url={review.selfieUrl} alt="Selfie for review" />
        {/* Only shown when there IS one. A document review carries both, and the ID photo is the
            half that actually carries a date of birth. A facial check carries only the selfie —
            deliberately, since that path exists precisely to avoid asking for government ID — and
            an empty tile beside it would read as a missing upload rather than as the design. */}
        {review.idDocumentUrl ? (
          <AuthedImage url={review.idDocumentUrl} alt="ID document for review" />
        ) : null}
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
              <X className="h-3.5 w-3.5" /> Under 18 — make it a minor account
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
