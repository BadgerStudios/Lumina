import { useEffect, useState } from "react";
import { Sparkles, ExternalLink, Loader2, AlertTriangle, Check } from "lucide-react";
import {
  useBillingConfig,
  useSubscription,
  useStartCheckout,
  useOpenBillingPortal,
} from "../../queries/billing";

/**
 * The Billing section of user settings.
 *
 * The whole payment backend — checkout sessions, the customer portal, signature-verified webhooks,
 * the subscription table — was already built and working, and nothing in the app referenced any of
 * it. There was no way for a user to subscribe, see what they were paying for, or cancel.
 *
 * Two states are kept carefully distinct, because conflating them is how a billing page lies:
 * **not configured** (this instance has no Stripe keys, so nobody can pay at all) and **configured
 * but this plan has no price** (Stripe is connected, that specific product isn't set up). Both are
 * the operator's problem, not the user's, so both say so plainly instead of showing a button that
 * fails.
 */
export function BillingSection() {
  const config = useBillingConfig();
  const subscription = useSubscription();
  const checkout = useStartCheckout();
  const portal = useOpenBillingPortal();
  const [outcome, setOutcome] = useState<"success" | "cancelled" | null>(null);

  // Stripe sends the browser back to /settings/billing?checkout=success|cancelled. The webhook is
  // what actually grants the subscription, and it may land a moment after the redirect — so this
  // acknowledges the return without claiming the subscription is live; `subscription` below is the
  // only thing that asserts that, and it refetches on focus.
  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("checkout");
    if (param === "success" || param === "cancelled") {
      setOutcome(param);
      const url = new URL(window.location.href);
      url.searchParams.delete("checkout");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  if (config.isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-signal-faint" />
      </div>
    );
  }

  const active = subscription.data?.active;
  const sub = subscription.data?.subscription;

  return (
    <div className="flex flex-col gap-4">
      {outcome === "success" && (
        <div className="flex items-start gap-2 rounded-lg border border-online/40 bg-online/10 px-3 py-2 text-sm text-online">
          <Check className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Payment received. If it doesn't show below yet, give it a moment — Stripe confirms it to
            the server separately.
          </span>
        </div>
      )}
      {outcome === "cancelled" && (
        <div className="rounded-lg border border-hairline bg-base-900 px-3 py-2 text-sm text-signal-dim">
          Checkout was cancelled — nothing was charged.
        </div>
      )}

      {!config.data?.configured && (
        <div className="flex items-start gap-2 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-sm text-amber">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Payments aren't switched on for this instance yet, so nothing here can be purchased.
            Everything else in Lumina works exactly as it does now.
          </span>
        </div>
      )}

      {active && sub ? (
        <div className="rounded-lg border border-accent/40 bg-accent/5 p-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-accent" />
            <span className="font-semibold text-signal">
              {config.data?.plans.find((p) => p.key === sub.planKey)?.name ?? sub.planKey}
            </span>
            <span className="rounded-full bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent">
              {sub.status.toLowerCase()}
            </span>
          </div>
          <p className="mt-2 text-sm text-signal-dim">
            {sub.cancelAtPeriodEnd
              ? // Said explicitly: "cancelled" and "already gone" are different, and a user who
                // cancelled should know they still have what they paid for.
                `Cancelled — you keep Premium until ${formatDate(sub.currentPeriodEnd)}.`
              : sub.currentPeriodEnd
                ? `Renews on ${formatDate(sub.currentPeriodEnd)}.`
                : "Active."}
          </p>
          <button
            type="button"
            onClick={() => portal.mutate()}
            disabled={portal.isPending}
            className="mt-3 flex items-center gap-1.5 rounded bg-base-700 px-3 py-1.5 text-sm font-medium text-signal hover:bg-base-600 disabled:opacity-50"
          >
            {portal.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
            Manage billing
          </button>
          <p className="mt-1.5 text-xs text-signal-faint">
            Cancelling, changing your card and past invoices all live in Stripe's own portal.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {(config.data?.plans ?? []).map((plan) => (
            <div key={plan.key} className="rounded-lg border border-hairline bg-base-900 p-4">
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-accent" />
                <span className="font-semibold text-signal">{plan.name}</span>
              </div>
              <p className="mt-1.5 text-sm text-signal-dim">{plan.description}</p>
              <button
                type="button"
                onClick={() => checkout.mutate(plan.key)}
                disabled={!config.data?.configured || !plan.available || checkout.isPending}
                className="mt-3 flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {checkout.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Subscribe
              </button>
              {config.data?.configured && !plan.available && (
                <p className="mt-1.5 text-xs text-amber">
                  This plan hasn't been set up in Stripe yet, so it can't be purchased.
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-signal-faint">
        Card details are handled entirely by Stripe's hosted checkout — they never reach Lumina's
        servers.
      </p>
    </div>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "your next billing date";
  return new Date(iso).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
}
