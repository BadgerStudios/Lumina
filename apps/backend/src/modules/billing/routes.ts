import type { FastifyInstance } from "fastify";
import { primaryAppOrigin } from "../../lib/appOrigin.js";
import type Stripe from "stripe";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { getStripe, isBillingConfigured, isWebhookConfigured, getPlan, getPriceId, PLANS } from "./stripe.js";

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

  fastify.get("/subscription", { preHandler: [requireAuth] }, async (request) => {
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
  fastify.post("/checkout", { preHandler: [requireAuth] }, async (request) => {
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
  fastify.post("/portal", { preHandler: [requireAuth] }, async (request) => {
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
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
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
      await recordTransaction({
        eventId: event.id,
        userId: await userIdForCustomer(charge.customer),
        kind: "REFUND",
        amountCents: charge.amount_refunded ?? 0,
        currency: charge.currency ?? "usd",
        description: "Refund",
        paymentIntentId: typeof charge.payment_intent === "string" ? charge.payment_intent : null,
      });
      break;
    }

    default:
      // Unhandled event types are acknowledged rather than erroring — Stripe sends many, and
      // 500ing on an event we simply don't care about would make it retry forever.
      break;
  }
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
