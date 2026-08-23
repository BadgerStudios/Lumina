import type { FastifyInstance } from "fastify";
import { handleTipCompleted } from "../economy/routes.js";
import { syncMembershipFromSubscription, handleMembershipInvoicePaid } from "../economy/memberships.js";
import { reverseEarningsForPaymentIntent } from "../economy/service.js";
// Minors get no billing surface at all — see modules/parental/service.ts.
import { requireAdult } from "../age/guard.js";
import { requireTurnstile } from "../../plugins/turnstile.js";
import { primaryAppOrigin } from "../../lib/appOrigin.js";
import type Stripe from "stripe";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { getStripe, isBillingConfigured, isWebhookConfigured, getPlan, getPriceId, PLANS } from "./stripe.js";
import { credit as creditCoins } from "../store/service.js";

const checkoutSchema = z.object({ planKey: z.string().min(1) });

/** Mounted under /api/billing */
export default async function billingRoutes(fastify: FastifyInstance) {
  /**
   * Stripe's webhook signature is computed over the RAW request body. Fastify's JSON parser would
   * hand us a re-serialized object whose bytes differ (key order, whitespace), and verification
   * would fail every time — so this content type is captured verbatim for this route's use.
   */
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      if (req.url === "/api/billing/webhook") {
        done(null, body);
        return;
      }
      try {
        done(null, JSON.parse((body as Buffer).toString("utf8") || "{}"));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  /** What the client needs to render billing UI, including whether billing works at all. */
  fastify.get("/config", async () => ({
    configured: isBillingConfigured(),
    publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? null,
    plans: PLANS.map((p) => ({
      key: p.key,
      name: p.name,
      description: p.description,
      available: Boolean(getPriceId(p)),
    })),
  }));

  fastify.get("/subscription", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const sub = await prisma.subscription.findFirst({
      where: { userId: request.userId!, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
      orderBy: { createdAt: "desc" },
    });
    if (!sub) return { active: false, subscription: null };
    return {
      active: sub.status === "ACTIVE" || sub.status === "TRIALING",
      subscription: {
        planKey: sub.planKey,
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      },
    };
  });

  /**
   * Starts a Stripe Checkout session. The client never handles card details — Stripe's hosted page
   * does, which keeps this server entirely out of PCI scope.
   */
  fastify.post("/checkout", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, preHandler: [requireAuth, requireAdult, requireTurnstile] }, async (request) => {
    const stripe = getStripe();
    if (!stripe) throw new BadRequestError("Billing is not configured on this server");

    const parsed = checkoutSchema.safeParse(request.body);
    if (!parsed.success) throw new BadRequestError("A plan is required");
    const plan = getPlan(parsed.data.planKey);
    if (!plan) throw new NotFoundError("Unknown plan");
    const priceId = getPriceId(plan);
    if (!priceId) throw new BadRequestError(`No Stripe price configured for ${plan.key}`);

    const user = await prisma.user.findUnique({
      where: { id: request.userId! },
      select: { id: true, email: true },
    });
    if (!user) throw new NotFoundError("User not found");

    const existing = await prisma.subscription.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: { stripeCustomerId: true },
    });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      // Reuse the existing Stripe customer when there is one, so a returning subscriber doesn't
      // accumulate duplicate customer records with split billing history.
      ...(existing?.stripeCustomerId
        ? { customer: existing.stripeCustomerId }
        : { customer_email: user.email }),
      success_url: `${primaryAppOrigin()}/settings/billing?checkout=success`,
      cancel_url: `${primaryAppOrigin()}/settings/billing?checkout=cancelled`,
      // Carried back on the webhook — it is how a Stripe customer is tied to a Lumina account.
      // Client-supplied ids are never trusted for this; only what we put here.
      metadata: { userId: user.id, planKey: plan.key },
      subscription_data: { metadata: { userId: user.id, planKey: plan.key } },
    });

    return { url: session.url };
  });

  /** Stripe's hosted billing portal — cancellations, card updates, invoice history. Far better than
   * reimplementing any of that, and it keeps card data off this server entirely. */
  fastify.post("/portal", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, preHandler: [requireAuth, requireAdult] }, async (request) => {
    const stripe = getStripe();
    if (!stripe) throw new BadRequestError("Billing is not configured on this server");

    const sub = await prisma.subscription.findFirst({
      where: { userId: request.userId! },
      orderBy: { createdAt: "desc" },
    });
    if (!sub) throw new NotFoundError("No billing account found");

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: `${primaryAppOrigin()}/settings/billing`,
    });
    return { url: session.url };
  });

  /**
   * Stripe webhook.
   *
   * Signature verification is mandatory, not best-effort: this endpoint is publicly reachable, and
   * without verification anyone could POST a fabricated `invoice.paid` and grant themselves a
   * subscription or pollute the revenue ledger. If no signing secret is configured the route refuses
   * everything rather than falling back to trusting the body.
   */
  fastify.post("/webhook", { config: { rateLimit: { max: 200, timeWindow: "1 minute" } } }, async (request, reply) => {
    const stripe = getStripe();
    if (!stripe || !isWebhookConfigured()) {
      // 503, not 400: this is the server being unconfigured, and Stripe should retry later rather
      // than treat the event as permanently rejected.
      return reply.code(503).send({ error: "Billing webhooks are not configured" });
    }

    const signature = request.headers["stripe-signature"];
    if (!signature || typeof signature !== "string") {
      return reply.code(400).send({ error: "Missing signature" });
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        request.body as Buffer,
        signature,
        env.STRIPE_WEBHOOK_SECRET!,
      );
    } catch (err) {
      request.log.warn({ err }, "stripe webhook signature verification failed");
      return reply.code(400).send({ error: "Invalid signature" });
    }

    try {
      await handleStripeEvent(event);
    } catch (err) {
      request.log.error({ err, eventId: event.id }, "stripe webhook handler failed");
      // 500 so Stripe retries — dropping a payment event silently would leave the ledger wrong
      // with no trace.
      return reply.code(500).send({ error: "Handler failed" });
    }

    return reply.code(200).send({ received: true });
  });
}

const STATUS_MAP: Record<string, "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELED" | "INCOMPLETE" | "UNPAID"> = {
  trialing: "TRIALING",
  active: "ACTIVE",
  past_due: "PAST_DUE",
  canceled: "CANCELED",
  incomplete: "INCOMPLETE",
  incomplete_expired: "CANCELED",
  unpaid: "UNPAID",
};

async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    /**
     * Store coin top-up. This is the ONLY place sparks are granted for money — the success URL
     * grants nothing, because anyone can visit a success URL.
     *
     * `credit()` keys on the session id, so Stripe's retries (it redelivers on any non-2xx, which
     * is normal operation rather than an edge case) cannot credit the same payment twice.
     */
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;

      // An ad campaign payment. Told apart by `metadata.kind`, which this server set when it
      // created the session — never inferred from the amount, which an advertiser can influence.
      // A tip. Attribution rides server-set metadata; posting is idempotent on the session id.
      if (session.metadata?.kind === "tip") {
        await handleTipCompleted(session);
        break;
      }
      if (session.metadata?.kind === "ad_campaign") {
        await fundAdCampaign(event, session);
        return;
      }

      // Subscription checkouts come through here too; those are handled by the subscription events
      // below, and have no coin metadata.
      const userId = session.metadata?.userId;
      const coins = Number(session.metadata?.coins);
      if (!userId || !Number.isFinite(coins) || coins <= 0) return;
      if (session.payment_status !== "paid") return;

      await creditCoins({
        userId,
        amount: coins,
        reason: "PURCHASE_BUNDLE",
        refId: session.id,
        note: session.metadata?.bundleKey,
      });
      return;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      // Creator memberships ride the same subscription machinery as Premium but land on their
      // own row — told apart by server-set metadata, exactly like tips vs coin top-ups above.
      if (sub.metadata?.kind === "membership") {
        await syncMembershipFromSubscription(sub);
        break;
      }
      const userId = sub.metadata?.userId;
      // Without a userId there is no account to attach this to. Logged and skipped rather than
      // guessed at — attaching a subscription to the wrong person is worse than missing one.
      if (!userId) return;

      const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;
      await prisma.subscription.upsert({
        where: { stripeSubscriptionId: sub.id },
        create: {
          userId,
          stripeCustomerId: String(sub.customer),
          stripeSubscriptionId: sub.id,
          status: STATUS_MAP[sub.status] ?? "INCOMPLETE",
          planKey: sub.metadata?.planKey ?? "unknown",
          currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
          cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
        },
        update: {
          status: STATUS_MAP[sub.status] ?? "INCOMPLETE",
          currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
          cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
        },
      });
      break;
    }

    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      // If this invoice belongs to a creator membership, it ALSO becomes creator revenue through
      // the standard funnel (idempotent on the invoice id). Premium invoices fall through — the
      // membership handler answers only for subscriptions it recognizes.
      await handleMembershipInvoicePaid(invoice);
      await recordTransaction({
        eventId: event.id,
        userId: await userIdForCustomer(invoice.customer),
        kind: "CHARGE",
        amountCents: invoice.amount_paid ?? 0,
        currency: invoice.currency ?? "usd",
        description: invoice.number ? `Invoice ${invoice.number}` : "Subscription payment",
        paymentIntentId: null,
      });
      break;
    }

    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const paymentIntentId =
        typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id ?? null;
      await recordTransaction({
        eventId: event.id,
        userId: await userIdForCustomer(charge.customer),
        kind: "REFUND",
        amountCents: charge.amount_refunded ?? 0,
        currency: charge.currency ?? "usd",
        description: "Refund",
        paymentIntentId,
      });
      // The display refund above never touches the creator's earning — reverse that too, or the
      // platform pays out on money it gave back. Only on a FULL refund: a partial refund's
      // proportional creator share is a policy call, so it's logged for manual handling instead.
      const chargeAmount = charge.amount ?? 0;
      const fullyRefunded = chargeAmount > 0 && (charge.amount_refunded ?? 0) >= chargeAmount;
      if (paymentIntentId && fullyRefunded) {
        await reverseCreatorEarnings(paymentIntentId, `refund:${charge.id}`, "refund");
      } else if (paymentIntentId) {
        console.error(
          `[refund-reversal] PARTIAL refund on PI ${paymentIntentId} (charge ${charge.id}) — creator earning NOT auto-reversed; manual review`,
        );
      }
      break;
    }

    case "charge.dispute.created": {
      // A chargeback: the money is being pulled back. Protective hold — don't let disputed money
      // mature into a payout. Pending earnings are reversed; matured/paid ones are logged so a
      // human decides (and can re-grant if the dispute is later won).
      const dispute = event.data.object as Stripe.Dispute;
      const paymentIntentId =
        typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id ?? null;
      if (paymentIntentId) {
        await reverseCreatorEarnings(paymentIntentId, `dispute:${dispute.id}`, "dispute");
      }
      break;
    }

    default:
      // Unhandled event types are acknowledged rather than erroring — Stripe sends many, and
      // 500ing on an event we simply don't care about would make it retry forever.
      break;
  }
}

/**
 * Marks an ad campaign paid, and records the money in the same ledger every other charge lands in.
 *
 * ## Idempotency, twice over
 *
 * Stripe redelivers a webhook on any non-2xx, which is normal operation rather than an edge case,
 * so this runs more than once for the same payment as a matter of course. Two constraints cover it:
 * `AdCampaign.stripeSessionId` is unique, and the update is conditioned on the campaign not already
 * being FUNDED, so a redelivery updates zero rows instead of double-marking. `recordTransaction`
 * keys on the Stripe event id and already treats a duplicate as a normal outcome.
 *
 * ## Why the amount comes from Stripe
 *
 * `amount_total` is what was actually collected. Reading `totalBudgetCents` off the campaign row
 * instead would record whatever the budget says *now*, which is not necessarily what was charged.
 */
async function fundAdCampaign(event: Stripe.Event, session: Stripe.Checkout.Session): Promise<void> {
  const campaignId = session.metadata?.campaignId;
  if (!campaignId) return;
  if (session.payment_status !== "paid") return;

  // `|| null`, not `?? null`: Stripe returns metadata values as strings, and an empty one is not a
  // user id — it is a foreign key violation waiting to happen.
  //
  // The existence check matters more than it looks. Transaction.userId is a real FK, so attaching
  // a payment to an account that no longer exists throws, the handler 500s, and Stripe retries
  // that event forever while the campaign is already funded — money taken, ledger permanently
  // missing a row. An advertiser deleting their account between checkout and webhook is unlikely
  // but entirely possible, and the ledger row matters more than the attribution: Transaction.user
  // is already `SetNull` on delete, so a null author is a shape this table expects.
  const claimedAdvertiserId = session.metadata?.advertiserId || null;
  const advertiser = claimedAdvertiserId
    ? await prisma.user.findUnique({ where: { id: claimedAdvertiserId }, select: { id: true } })
    : null;
  const advertiserId = advertiser?.id ?? null;

  const paidCents = session.amount_total ?? 0;

  const result = await prisma.adCampaign.updateMany({
    where: { id: campaignId, fundingStatus: { not: "FUNDED" } },
    data: {
      fundingStatus: "FUNDED",
      paidCents,
      paidAt: new Date(),
      stripeSessionId: session.id,
    },
  });

  // Zero rows means a redelivery of an already-funded campaign. The transaction is still recorded
  // below — `recordTransaction` dedupes on the event id, so this stays correct either way, and
  // returning early here would risk losing the ledger row if the first delivery failed after the
  // campaign update but before the transaction write.
  void result;

  await recordTransaction({
    eventId: event.id,
    userId: advertiserId,
    kind: "CHARGE",
    amountCents: paidCents,
    currency: session.currency ?? "usd",
    description: `Ad campaign ${campaignId}`,
    paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
  });
}

async function userIdForCustomer(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null): Promise<string | null> {
  if (!customer) return null;
  const customerId = typeof customer === "string" ? customer : customer.id;
  const sub = await prisma.subscription.findFirst({
    where: { stripeCustomerId: customerId },
    select: { userId: true },
  });
  return sub?.userId ?? null;
}

/**
 * Writes one ledger row, keyed on the Stripe event id.
 *
 * Stripe retries webhook delivery until it receives a 2xx, so the same event genuinely does arrive
 * more than once — the unique constraint on stripeEventId is what stops a retry from double-counting
 * revenue. A duplicate is a normal outcome here, not an error.
 */
/**
 * Reverse every creator earning funded by one PaymentIntent, and surface the ones a human must
 * finish. `reverseEarningsForPaymentIntent` is ledger-safe by construction: it only unwinds
 * still-PENDING earnings and reports matured/paid ones as `requires-manual` rather than corrupt the
 * ledger or silently claw back money a creator was already paid. Those land as a loud, greppable
 * operator log — the automation fixes the common fast-refund case; the rare matured case is visible.
 */
async function reverseCreatorEarnings(paymentIntentId: string, reason: string, kind: string): Promise<void> {
  const outcomes = await reverseEarningsForPaymentIntent(paymentIntentId, reason);
  for (const o of outcomes) {
    if (o.status === "requires-manual") {
      console.error(
        `[refund-reversal] MANUAL REVIEW: ${kind} on PI ${paymentIntentId} — earning ${o.eventId} is ${o.earningStatus} (${o.amountMinor} minor units); already matured/paid, NOT auto-clawed back`,
      );
    } else if (o.status === "reversed") {
      console.log(
        `[refund-reversal] reversed ${kind} earning ${o.eventId} (${o.amountMinor} minor units) on PI ${paymentIntentId}`,
      );
    }
  }
}

async function recordTransaction(params: {
  eventId: string;
  userId: string | null;
  kind: "CHARGE" | "REFUND";
  amountCents: number;
  currency: string;
  description: string;
  paymentIntentId: string | null;
}): Promise<void> {
  if (params.amountCents <= 0) return;
  try {
    await prisma.transaction.create({
      data: {
        stripeEventId: params.eventId,
        userId: params.userId,
        kind: params.kind,
        amountCents: params.amountCents,
        currency: params.currency,
        description: params.description,
        stripePaymentIntentId: params.paymentIntentId,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return; // already recorded
    throw err;
  }
}
