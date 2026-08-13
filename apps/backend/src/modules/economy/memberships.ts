import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type Stripe from "stripe";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { requireAdult } from "../age/guard.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/errors.js";
import { getStripe, isBillingConfigured } from "../billing/stripe.js";
import { env } from "../../config/env.js";
import { recordRevenueEvent, qualifyAndPost } from "./service.js";
import { pushInboxNotification } from "../inbox/service.js";

/**
 * Creator memberships: a monthly supporter tier per creator, billed by Stripe subscriptions.
 *
 * The division of labor is strict: Stripe owns the billing relationship (retries, dunning,
 * cancellation timing), CreatorMembership rows mirror that state, and MONEY only ever moves when
 * an `invoice.paid` webhook flows through the same revenue-event funnel as tips and gifts —
 * under the versioned `membership` policy (90/10 at launch). The success URL grants nothing;
 * subscription state comes exclusively from signed webhooks.
 */

const tierSchema = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(300).optional().nullable(),
  priceMinor: z.number().int().min(100).max(5000), // $1–$50/mo
  active: z.boolean(),
});

/** invoice.subscription moved into invoice.parent.subscription_details across Stripe API
 * versions; read both shapes rather than pinning to whichever this SDK ships today. */
function subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const direct = (invoice as unknown as { subscription?: string | { id: string } | null }).subscription;
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object") return direct.id;
  const parent = (invoice as unknown as {
    parent?: { subscription_details?: { subscription?: string | { id: string } | null } };
  }).parent;
  const nested = parent?.subscription_details?.subscription;
  if (typeof nested === "string") return nested;
  if (nested && typeof nested === "object") return nested.id;
  return null;
}

/** Mirror one Stripe subscription's state onto the membership row. Called from the billing
 * webhook for subscriptions carrying `metadata.kind === "membership"`. */
export async function syncMembershipFromSubscription(sub: Stripe.Subscription): Promise<void> {
  const { memberId, creatorId } = (sub.metadata ?? {}) as Record<string, string>;
  if (!memberId || !creatorId) return;

  const status =
    sub.status === "active" || sub.status === "trialing"
      ? "ACTIVE"
      : sub.status === "past_due" || sub.status === "unpaid"
        ? "PAST_DUE"
        : sub.status === "canceled" || sub.status === "incomplete_expired"
          ? "CANCELED"
          : "INCOMPLETE";
  const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;
  const priceMinor = sub.items?.data?.[0]?.price?.unit_amount ?? 0;

  const existing = await prisma.creatorMembership.findUnique({
    where: { creatorId_memberId: { creatorId, memberId } },
    select: { status: true },
  });
  await prisma.creatorMembership.upsert({
    where: { creatorId_memberId: { creatorId, memberId } },
    create: {
      creatorId,
      memberId,
      status,
      priceMinor,
      stripeSubscriptionId: sub.id,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    },
    update: {
      status,
      stripeSubscriptionId: sub.id,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
      ...(priceMinor > 0 ? { priceMinor } : {}),
    },
  });

  if (status === "ACTIVE" && existing?.status !== "ACTIVE") {
    await pushInboxNotification({
      userId: creatorId,
      kind: "EARNING",
      bundleKey: `SUPPORTER:${new Date().toISOString().slice(0, 10)}`,
      actorId: memberId,
      preview: "You have a new supporter",
    }).catch(() => undefined);
  }
}

/** A paid membership invoice → revenue event → ledger, idempotent on the invoice id. The ONLY
 * place membership money enters the funnel. */
export async function handleMembershipInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  const subId = subscriptionIdFromInvoice(invoice);
  if (!subId || !invoice.amount_paid) return;
  const membership = await prisma.creatorMembership.findUnique({ where: { stripeSubscriptionId: subId } });
  if (!membership) return;

  const event = await recordRevenueEvent({
    eventType: "membership.invoice_paid",
    idempotencyKey: `meminv:${invoice.id ?? `${subId}:${invoice.created}`}`,
    source: "stripe",
    currency: (invoice.currency ?? "usd").toLowerCase(),
    grossMinor: BigInt(invoice.amount_paid),
    userId: membership.memberId,
    creatorId: membership.creatorId,
    contentRef: `membership:${membership.id}`,
    externalRef: invoice.id ?? subId,
  });
  await qualifyAndPost(event.id);
}

/** Mounted under /api/economy, sibling of economyRoutes. Adult-gated throughout. */
export default async function membershipRoutes(fastify: FastifyInstance) {
  // ---- the creator's own tier
  fastify.get("/creator/tier", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const [tier, supporters] = await Promise.all([
      prisma.creatorTier.findUnique({ where: { creatorId: request.userId! } }),
      prisma.creatorMembership.count({ where: { creatorId: request.userId!, status: "ACTIVE" } }),
    ]);
    return {
      tier: tier
        ? { name: tier.name, description: tier.description, priceMinor: tier.priceMinor, active: tier.active }
        : null,
      supporters,
    };
  });

  fastify.put(
    "/creator/tier",
    { schema: { body: tierSchema }, preHandler: [requireAuth, requireAdult] },
    async (request) => {
      const body = request.body as z.infer<typeof tierSchema>;
      await prisma.creatorTier.upsert({
        where: { creatorId: request.userId! },
        create: {
          creatorId: request.userId!,
          name: body.name,
          description: body.description ?? null,
          priceMinor: body.priceMinor,
          active: body.active,
        },
        update: {
          name: body.name,
          description: body.description ?? null,
          // NOTE: existing supporters keep billing at the price they subscribed at (their Stripe
          // subscription owns its own price); this only changes what NEW supporters see.
          priceMinor: body.priceMinor,
          active: body.active,
        },
      });
      return { ok: true };
    },
  );

  fastify.get("/creator/supporters", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const rows = await prisma.creatorMembership.findMany({
      where: { creatorId: request.userId!, status: "ACTIVE" },
      include: { member: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return rows.map((r) => ({
      member: r.member,
      priceMinor: r.priceMinor,
      since: r.createdAt.toISOString(),
    }));
  });

  // ---- viewing + joining someone else's tier
  fastify.get("/creators/:creatorId/tier", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const { creatorId } = request.params as { creatorId: string };
    const tier = await prisma.creatorTier.findUnique({ where: { creatorId } });
    if (!tier || !tier.active) return { tier: null, myMembership: null };
    const mine = await prisma.creatorMembership.findUnique({
      where: { creatorId_memberId: { creatorId, memberId: request.userId! } },
    });
    return {
      tier: { name: tier.name, description: tier.description, priceMinor: tier.priceMinor },
      myMembership:
        mine && mine.status !== "CANCELED"
          ? { status: mine.status, currentPeriodEnd: mine.currentPeriodEnd?.toISOString() ?? null }
          : null,
    };
  });

  fastify.post(
    "/memberships/subscribe",
    { schema: { body: z.object({ creatorId: z.string().min(1) }) }, preHandler: [requireAuth, requireAdult] },
    async (request) => {
      const { creatorId } = request.body as { creatorId: string };
      if (creatorId === request.userId) throw new BadRequestError("You can't subscribe to yourself");
      const creator = await prisma.user.findUnique({
        where: { id: creatorId },
        select: { id: true, isMinor: true, ageRecordedAt: true, isBot: true, username: true },
      });
      if (!creator || creator.isBot) throw new NotFoundError("Creator not found");
      if (creator.isMinor || creator.ageRecordedAt === null) throw new BadRequestError("This account can't receive memberships");
      const tier = await prisma.creatorTier.findUnique({ where: { creatorId } });
      if (!tier || !tier.active) throw new NotFoundError("This creator has no membership tier");
      const existing = await prisma.creatorMembership.findUnique({
        where: { creatorId_memberId: { creatorId, memberId: request.userId! } },
        select: { status: true },
      });
      if (existing && (existing.status === "ACTIVE" || existing.status === "PAST_DUE")) {
        throw new BadRequestError("You're already a supporter");
      }
      if (!isBillingConfigured()) throw new ConflictError("Payments aren't configured on this server yet");

      const stripe = getStripe()!;
      const metadata = { kind: "membership", memberId: request.userId!, creatorId };
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: tier.priceMinor,
              recurring: { interval: "month" },
              product_data: { name: `${tier.name} — @${creator.username}`, tax_code: "txcd_10000000" },
            },
            quantity: 1,
          },
        ],
        // Attribution rides the SUBSCRIPTION metadata — every later invoice webhook resolves
        // back through the subscription id, so the browser never asserts who is owed what.
        metadata,
        subscription_data: { metadata },
        success_url: `${env.PUBLIC_APP_URL}/foryou?membership=thanks`,
        cancel_url: `${env.PUBLIC_APP_URL}/foryou`,
      });
      return { checkoutUrl: session.url };
    },
  );

  fastify.post(
    "/memberships/:creatorId/cancel",
    { preHandler: [requireAuth, requireAdult] },
    async (request) => {
      const { creatorId } = request.params as { creatorId: string };
      const membership = await prisma.creatorMembership.findUnique({
        where: { creatorId_memberId: { creatorId, memberId: request.userId! } },
      });
      if (!membership || membership.status === "CANCELED") throw new NotFoundError("No active membership");
      // Cancel at period end — the supporter keeps what they paid for; the deleted-subscription
      // webhook flips the row to CANCELED when the period actually lapses.
      if (membership.stripeSubscriptionId && isBillingConfigured()) {
        await getStripe()!.subscriptions.update(membership.stripeSubscriptionId, { cancel_at_period_end: true });
      }
      return { ok: true, endsAt: membership.currentPeriodEnd?.toISOString() ?? null };
    },
  );

  fastify.get("/memberships/mine", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const rows = await prisma.creatorMembership.findMany({
      where: { memberId: request.userId!, status: { not: "CANCELED" } },
      include: { creator: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => ({
      creator: r.creator,
      status: r.status,
      priceMinor: r.priceMinor,
      currentPeriodEnd: r.currentPeriodEnd?.toISOString() ?? null,
    }));
  });
}
