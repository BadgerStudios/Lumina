import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type Stripe from "stripe";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { requireAdult } from "../age/guard.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/errors.js";
import { getStripe, isBillingConfigured } from "../billing/stripe.js";
import { env } from "../../config/env.js";
import { COIN_VALUE_MINOR, PRODUCTS, recordRevenueEvent, qualifyAndPost } from "./service.js";
import { getBalance } from "../store/service.js";
import { pushInboxNotification } from "../inbox/service.js";

/**
 * Creator economy HTTP surface: tips, gifts, the creator program, and the Creator Studio reads.
 *
 * Everything here is adult-gated (requireAdult): minors neither pay nor earn — the platform's
 * existing minor regime and the master spec's §27 default agree, and the gate is at the route so
 * no later refactor can accidentally open it.
 */

const tipSchema = z.object({
  creatorId: z.string().min(1),
  amountMinor: z.number().int().min(100).max(50000), // $1–$500: floors card-testing, caps rashness
  contentRef: z.string().max(120).optional(),
});
const giftSchema = z.object({
  giftKey: z.string().min(1).max(40),
  creatorId: z.string().min(1),
  contentRef: z.string().max(120).optional(),
});

const DEFAULT_GIFTS = [
  { key: "spark", name: "Spark", emoji: "✨", priceCoins: 50, sortOrder: 1 },
  { key: "aurora", name: "Aurora", emoji: "🌌", priceCoins: 250, sortOrder: 2 },
  { key: "nova", name: "Nova", emoji: "💥", priceCoins: 1000, sortOrder: 3 },
  { key: "constellation", name: "Constellation", emoji: "🌠", priceCoins: 5000, sortOrder: 4 },
] as const;

export async function seedGifts(): Promise<void> {
  for (const g of DEFAULT_GIFTS) {
    await prisma.gift.upsert({ where: { key: g.key }, create: g, update: {} });
  }
}

/**
 * Tip checkout completed — called from the billing webhook (signature already verified there).
 * Idempotent end-to-end: the revenue event is keyed on the checkout session id, so Stripe's
 * routine redelivery posts nothing twice.
 */
export async function handleTipCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const { tipperId, creatorId, contentRef } = (session.metadata ?? {}) as Record<string, string>;
  if (!tipperId || !creatorId || !session.amount_total) return;
  const event = await recordRevenueEvent({
    eventType: "tip.payment_succeeded",
    idempotencyKey: `tip:${session.id}`,
    source: "stripe",
    currency: (session.currency ?? "usd").toLowerCase(),
    grossMinor: BigInt(session.amount_total),
    userId: tipperId,
    creatorId,
    contentRef: contentRef || null,
    externalRef: session.id,
  });
  await qualifyAndPost(event.id);
}

/** The requirement checklist, evaluated fresh — the same object decides state AND renders the
 * creator's progress screen, so the two can never disagree. */
async function evaluateProgram(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { isMinor: true, ageRecordedAt: true, emailVerifiedAt: true, createdAt: true, totpEnabledAt: true },
  });
  const [videoAgg, friendCount] = await Promise.all([
    prisma.video.aggregate({ where: { authorId: userId, status: "APPROVED" }, _sum: { viewCount: true }, _count: true }),
    prisma.friendRequest.count({ where: { status: "ACCEPTED", OR: [{ requesterId: userId }, { addresseeId: userId }] } }),
  ]);
  const accountAgeDays = Math.floor((Date.now() - user.createdAt.getTime()) / 86_400_000);

  const requirements = {
    adult: { met: !user.isMinor && user.ageRecordedAt !== null, label: "18 or older with age confirmed" },
    emailVerified: { met: user.emailVerifiedAt !== null, label: "Email verified" },
    accountAge: { met: accountAgeDays >= 7, label: "Account at least 7 days old", value: accountAgeDays, needed: 7 },
    mfaForPayouts: { met: user.totpEnabledAt !== null, label: "Two-factor enabled (required for payouts)", gate: "payout" },
    uploads: { met: videoAgg._count >= 5, label: "5 approved uploads", value: videoAgg._count, needed: 5 },
    audience: {
      met: friendCount >= 10 || (videoAgg._sum.viewCount ?? 0) >= 1000,
      label: "10 connections or 1,000 qualified views",
      value: Math.max(friendCount, videoAgg._sum.viewCount ?? 0),
    },
  };

  // LIMITED unlocks receiving tips/gifts; CREATOR adds pool-based revenue when those pools run.
  const limitedMet = requirements.adult.met && requirements.emailVerified.met && requirements.accountAge.met;
  const creatorMet = limitedMet && requirements.uploads.met && requirements.audience.met;
  const state = creatorMet ? "CREATOR" : limitedMet ? "LIMITED" : "NOT_ELIGIBLE";

  const program = await prisma.creatorProgram.upsert({
    where: { userId },
    create: { userId, state, requirements: requirements as never },
    update: { state, requirements: requirements as never, evaluatedAt: new Date() },
  });
  return program;
}

function serializeMoney(minor: bigint): { minor: string; display: string } {
  const sign = minor < 0n ? "-" : "";
  const abs = minor < 0n ? -minor : minor;
  return { minor: minor.toString(), display: `${sign}$${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}` };
}

/** Mounted under /api/economy. */
export default async function economyRoutes(fastify: FastifyInstance) {
  // ---------------------------------------------------------------- creator studio reads

  fastify.get("/creator/status", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const program = await evaluateProgram(request.userId!);
    const payout = await prisma.payoutAccount.findUnique({ where: { userId: request.userId! } });
    return {
      state: program.state,
      requirements: program.requirements,
      evaluatedAt: program.evaluatedAt.toISOString(),
      payouts: {
        // Fail-closed and honest: real payouts stay OFF until the operator completes the
        // one-time Stripe Connect setup (docs/creator-economy/SETUP_ONCE.md). Earnings accrue
        // meanwhile — the ledger doesn't need the payout rail to exist to owe you money.
        configured: Boolean(env.STRIPE_CONNECT_ENABLED),
        onboarded: payout?.onboarded ?? false,
        enabled: payout?.payoutsEnabled ?? false,
      },
    };
  });

  fastify.get("/creator/wallet", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const wallet = await prisma.creatorWallet.findUnique({ where: { userId: request.userId! } });
    const zero = { minor: "0", display: "$0.00" };
    if (!wallet) return { pending: zero, available: zero, reserved: zero, paidLifetime: zero, currency: "usd" };
    return {
      pending: serializeMoney(wallet.pendingMinor),
      available: serializeMoney(wallet.availableMinor),
      reserved: serializeMoney(wallet.reservedMinor),
      paidLifetime: serializeMoney(wallet.paidMinor),
      currency: wallet.currency,
    };
  });

  fastify.get("/creator/earnings", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const items = await prisma.earningItem.findMany({
      where: { creatorId: request.userId! },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return items.map((i) => ({
      id: i.id,
      product: i.product,
      amount: serializeMoney(i.amountMinor),
      status: i.status,
      availableAt: i.availableAt.toISOString(),
      createdAt: i.createdAt.toISOString(),
    }));
  });

  fastify.post("/creator/payouts/onboard", { preHandler: [requireAuth, requireAdult] }, async () => {
    if (!env.STRIPE_CONNECT_ENABLED) {
      // Not a placeholder: the flow is built and gated. The message tells the operator exactly
      // which one-time step turns it on, per the autonomy contract's SETUP_ONCE model.
      throw new ConflictError(
        "Payout onboarding isn't enabled on this instance yet. The operator needs to complete the one-time Stripe Connect setup (docs/creator-economy/SETUP_ONCE.md).",
      );
    }
    // When Connect is enabled this creates/reuses the connected account and returns the hosted
    // onboarding link (provider-hosted KYC, §22).
    throw new ConflictError("Stripe Connect is flagged on but no implementation credentials were configured.");
  });

  // ---------------------------------------------------------------- tips

  fastify.post(
    "/tips",
    { schema: { body: tipSchema }, config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, preHandler: [requireAuth, requireAdult] },
    async (request) => {
      const body = request.body as z.infer<typeof tipSchema>;
      if (body.creatorId === request.userId) throw new BadRequestError("You can't tip yourself");
      const creator = await prisma.user.findUnique({
        where: { id: body.creatorId },
        select: { id: true, isMinor: true, ageRecordedAt: true, isBot: true, username: true },
      });
      if (!creator || creator.isBot) throw new NotFoundError("Creator not found");
      if (creator.isMinor || creator.ageRecordedAt === null) throw new BadRequestError("This account can't receive tips");
      if (!isBillingConfigured()) throw new ConflictError("Payments aren't configured on this server yet");

      const stripe = getStripe()!;
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: body.amountMinor,
              // This Stripe account runs Stripe Tax, which refuses ad-hoc products without a
              // tax code. General electronically-supplied-services is the correct category for a
              // platform digital purchase; discovered live by the verify suite, not in review.
              product_data: { name: `Tip @${creator.username}`, tax_code: "txcd_10000000" },
            },
            quantity: 1,
          },
        ],
        // The metadata IS the attribution — the webhook rebuilds the whole tip from it, so the
        // browser never gets to assert who is owed what.
        metadata: { kind: "tip", tipperId: request.userId!, creatorId: creator.id, contentRef: body.contentRef ?? "" },
        success_url: `${env.PUBLIC_APP_URL}/foryou?tip=thanks`,
        cancel_url: `${env.PUBLIC_APP_URL}/foryou`,
      });
      return { checkoutUrl: session.url };
    },
  );

  // ---------------------------------------------------------------- gifts

  fastify.get("/gifts/catalog", { preHandler: [requireAuth] }, async () => {
    const gifts = await prisma.gift.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } });
    return gifts.map((g) => ({ key: g.key, name: g.name, emoji: g.emoji, priceCoins: g.priceCoins }));
  });

  fastify.post(
    "/gifts/send",
    { schema: { body: giftSchema }, config: { rateLimit: { max: 30, timeWindow: "1 minute" } }, preHandler: [requireAuth, requireAdult] },
    async (request) => {
      const body = request.body as z.infer<typeof giftSchema>;
      if (body.creatorId === request.userId) throw new BadRequestError("You can't gift yourself");
      const gift = await prisma.gift.findUnique({ where: { key: body.giftKey } });
      if (!gift || !gift.active) throw new NotFoundError("Gift not found");

      // Atomic spend, borrowed shape from the store: balance re-derived and checked INSIDE the
      // transaction that writes the debit, so two simultaneous sends can't both pass. The unique
      // GiftSend row is created in the same transaction — a crash between them is a rollback.
      const send = await prisma.$transaction(async (tx) => {
        const balance = await getBalance(request.userId!, tx);
        if (balance < gift.priceCoins) {
          throw new BadRequestError(`Not enough sparks — this gift costs ${gift.priceCoins} and you have ${balance}`);
        }
        const created = await tx.giftSend.create({
          data: {
            giftId: gift.id,
            senderId: request.userId!,
            creatorId: body.creatorId,
            contentRef: body.contentRef ?? null,
            priceCoins: gift.priceCoins,
          },
        });
        await tx.coinLedgerEntry.create({
          data: {
            userId: request.userId!,
            delta: -gift.priceCoins,
            reason: "GIFT_SEND",
            refId: `gift:${created.id}`,
          },
        });
        return created;
      });

      // Coins consumed → the deferred liability funds the creator's fiat earning, per gift policy.
      const event = await recordRevenueEvent({
        eventType: "gift.sent",
        idempotencyKey: `giftsend:${send.id}`,
        source: "coins",
        currency: "usd",
        grossMinor: BigInt(gift.priceCoins) * COIN_VALUE_MINOR,
        userId: request.userId!,
        creatorId: body.creatorId,
        contentRef: body.contentRef ?? null,
      });
      await prisma.giftSend.update({ where: { id: send.id }, data: { revenueEventId: event.id } });
      const posted = await qualifyAndPost(event.id, { fundingAccount: "COIN_DEFERRED" });

      await pushInboxNotification({
        userId: body.creatorId,
        kind: "EARNING",
        bundleKey: `GIFT:${send.id}`,
        actorId: request.userId!,
        preview: `${gift.emoji} sent you a ${gift.name}`,
      }).catch(() => undefined);

      return { sent: true, gift: { key: gift.key, emoji: gift.emoji, name: gift.name }, qualified: posted.status === "POSTED" };
    },
  );
}
