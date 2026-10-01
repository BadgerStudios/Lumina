import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { requireAuth, requireAdmin, requireOwner } from "../../plugins/authenticate.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { sendMail } from "../../lib/mail.js";
import { sendPushToUser } from "../../lib/push.js";
import { ROLE_LADDER, isOwner } from "../../lib/platformRole.js";
import { recordFlag, AGE_PROVENANCE_DAYS } from "../flags/service.js";
import { describeUserAgent } from "./userAgent.js";
import { joinWelcomeServer } from "../onboarding/welcome.js";

/**
 * The owner's age review (owner decision 2026-10-01).
 *
 * Two kinds of sign-up are held instead of admitted: an under-18 answer (13-17, walled from adults
 * once approved), and the contradiction "picked an adult age range but typed a birth date under the
 * minimum" - almost always a mistyped year. A held account exists but cannot get a session
 * (issueTokenPair refuses it) until the owner decides:
 *
 *  - APPROVE: the account opens. A contradiction is approved as the adult range the person picked,
 *    and the birth date that caused it is cleared (it was the typo). An under-18 answer stays a
 *    minor account, with every adult surface closed to it as before.
 *  - DENY: the account and everything in it is deleted, and the sign-up device goes on the usual
 *    under-age cooldown. Nothing about a child is kept beyond the hashed flag.
 *
 * Self-declared under-13 answers are still refused outright at sign-up (the legal floor), and are
 * listed here as "Refused sign-ups" with the device they came from, for the owner to see.
 *
 * Provenance (IP, device, user agent) is owner-only and every read is written to the staff audit
 * log, the same rule as video upload provenance.
 */

export async function notifyStaffOfAgeReview(username: string): Promise<void> {
  const owners = await prisma.user.findMany({
    where: { platformRole: { in: ROLE_LADDER.filter((r) => isOwner(r)) } },
    select: { id: true },
  });
  await Promise.all(
    owners.map((o) =>
      sendPushToUser(o.id, {
        title: "Age review",
        body: `@${username} signed up and is waiting for your approval.`,
        url: "/owner",
        tag: "age-review",
        audience: "staff",
      }).catch(() => {}),
    ),
  );
}

const SUPPORT = "support@badgerstudios.net";

function decisionMail(username: string, approved: boolean, minor = false) {
  return approved
    ? {
        subject: "Your Lumina account is ready",
        text:
          `Hi @${username},\n\nGood news: your Lumina account has been approved. You can sign in now.\n\n` +
          (minor
            ? "Because you're under 18, a parent or guardian needs to accept your account before you can use everything. " +
              "After you sign in, open Settings to find the pairing code to give them.\n\n"
            : "") +
          `If you have any questions, write to ${SUPPORT}.\n\nThe Lumina team`,
      }
    : {
        subject: "About your Lumina sign-up",
        text:
          `Hi,\n\nWe're sorry, but we couldn't approve the Lumina account @${username}, so it has been removed along with ` +
          `the details you entered.\n\nIf you think this was a mistake, write to ${SUPPORT}.\n\nThe Lumina team`,
      };
}

async function audit(actorId: string, actionType: string, targetType: string, targetId: string, reason?: string) {
  await prisma.staffAuditLog.create({ data: { actorId, actionType, targetType, targetId, reason: reason?.slice(0, 300) ?? null } });
}

const decideSchema = z.object({
  decision: z.enum(["APPROVE", "DENY"]),
  note: z.string().trim().max(300).optional(),
});

export function registerOwnerAgeRoutes(fastify: FastifyInstance) {
  /** Everything waiting on an age decision, plus the refused sign-ups of the last 90 days. */
  fastify.get("/age-queue", { preHandler: [requireAuth, requireAdmin] }, async () => {
    const since = new Date(Date.now() - AGE_PROVENANCE_DAYS * 24 * 60 * 60 * 1000);
    const [pending, refused, decided] = await Promise.all([
      prisma.user.findMany({
        where: { ageReview: "PENDING" },
        orderBy: { createdAt: "asc" },
        select: {
          id: true, username: true, displayName: true, email: true, createdAt: true, ageBracket: true, birthDate: true,
          ageReviewReason: true, signupCountry: true, signupClient: true, signupUserAgent: true, signupDevice: true,
        },
      }),
      prisma.accountFlag.findMany({
        where: { reasonCode: { in: ["AGE_UNDER_MINIMUM", "AGE_MISMATCH", "AGE_SIGNUP_COOLDOWN"] }, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: { id: true, reasonCode: true, detail: true, createdAt: true, country: true, clientType: true, userAgent: true,
          ipAddress: true, deviceHash: true, active: true, resolvedAt: true, userId: true },
      }),
      prisma.user.findMany({
        where: { ageReview: "APPROVED" },
        orderBy: { ageReviewedAt: "desc" },
        take: 20,
        select: { id: true, username: true, ageReviewReason: true, ageReviewedAt: true, isMinor: true },
      }),
    ]);
    // How many other accounts have signed in from each held account's sign-up device: the single
    // most useful thing to know when deciding, and safe to show as a number.
    const devices = pending.map((u) => u.signupDevice).filter((d): d is string => !!d);
    const shared = devices.length
      ? await prisma.refreshToken.findMany({ where: { deviceFingerprint: { in: devices } }, select: { deviceFingerprint: true, userId: true }, distinct: ["deviceFingerprint", "userId"] })
      : [];
    const sharedCount = (d: string | null, self: string) => (d ? shared.filter((s) => s.deviceFingerprint === d && s.userId !== self).length : 0);
    return {
      pending: pending.map((u) => ({
        id: u.id, username: u.username, displayName: u.displayName, email: u.email, createdAt: u.createdAt.toISOString(),
        ageBracket: u.ageBracket, birthDate: u.birthDate?.toISOString().slice(0, 10) ?? null, reason: u.ageReviewReason,
        country: u.signupCountry, client: u.signupClient, device: describeUserAgent(u.signupUserAgent, u.signupClient),
        otherAccountsOnDevice: sharedCount(u.signupDevice, u.id),
      })),
      refused: refused.map((f) => ({
        id: f.id, reasonCode: f.reasonCode, detail: f.detail, createdAt: f.createdAt.toISOString(), country: f.country,
        client: f.clientType, device: f.userAgent ? describeUserAgent(f.userAgent, f.clientType) : null,
        hasProvenance: !!(f.ipAddress || f.userAgent), heldForReview: !!f.detail?.includes("held for owner review"),
        active: f.active,
      })),
      decided: decided.map((u) => ({ id: u.id, username: u.username, reason: u.ageReviewReason, decidedAt: u.ageReviewedAt?.toISOString() ?? null, minor: u.isMinor })),
    };
  });

  fastify.post("/age-queue/:userId/decide", { preHandler: [requireAuth, requireOwner] }, async (request) => {
    const { userId } = request.params as { userId: string };
    const parsed = decideSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new BadRequestError("decision must be APPROVE or DENY");
    const { decision, note } = parsed.data;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, email: true, ageReview: true, ageReviewReason: true, signupDevice: true, signupIp: true,
        signupUserAgent: true, signupCountry: true, signupClient: true },
    });
    if (!user) throw new NotFoundError("That account no longer exists");
    if (user.ageReview !== "PENDING") throw new BadRequestError("That account isn't waiting for an age decision");

    if (decision === "APPROVE") {
      const contradiction = (user.ageReviewReason ?? "").startsWith("Picked ");
      // Conditional on still PENDING, so two staff deciding at once can't both act.
      const { count } = await prisma.user.updateMany({
        where: { id: user.id, ageReview: "PENDING" },
        data: {
          ageReview: "APPROVED",
          ageReviewedAt: new Date(),
          ageReviewedById: request.userId!,
          hiddenFromDirectory: false,
          // The birth date was the typo: the account becomes the adult range the person picked.
          ...(contradiction ? { isMinor: false, birthDate: null } : {}),
        },
      });
      if (count === 0) throw new BadRequestError("That account was already decided");
      // Approved: the sign-up's own age flags are settled, and with them the device cooldown the
      // typo put on (isSignupBlocked reads active flags), so the person's phone isn't left blocked.
      await prisma.accountFlag.updateMany({
        where: { userId: user.id, reasonCode: { in: ["AGE_UNDER_MINIMUM", "AGE_MISMATCH"] }, active: true },
        data: { active: false, resolvedAt: new Date(), resolvedById: request.userId! },
      });
      void joinWelcomeServer(user.id).catch(() => {});
      await audit(request.userId!, "AGE_SIGNUP_APPROVE", "user", user.id, `@${user.username}${note ? ` - ${note}` : ""}`);
      void sendMail({ to: user.email, ...decisionMail(user.username, true, !contradiction) }).catch(() => {});
      return { ok: true, decision, minor: !contradiction };
    }

    // DENY: claim the decision first so a concurrent approve can't open the account meanwhile, then
    // record (the audit row and the device cooldown must outlive the account), then delete.
    const claimed = await prisma.user.updateMany({ where: { id: user.id, ageReview: "PENDING" }, data: { ageReview: "DENIED" } });
    if (claimed.count === 0) throw new BadRequestError("That account was already decided");
    await audit(request.userId!, "AGE_SIGNUP_DENY", "user", user.id, `@${user.username}${note ? ` - ${note}` : ""}`);
    await recordFlag({
      email: user.email,
      ipAddress: user.signupIp,
      deviceFingerprint: user.signupDevice,
      reasonCode: "AGE_SIGNUP_COOLDOWN",
      detail: `age review denied for @${user.username}`,
      provenance: { userAgent: user.signupUserAgent, country: user.signupCountry, clientType: user.signupClient },
    });
    void sendMail({ to: user.email, ...decisionMail(user.username, false) }).catch(() => {});
    await prisma.user.delete({ where: { id: user.id } });
    return { ok: true, decision };
  });

  /** Where an account came from and every device it has signed in on. Owner-only, audited. */
  fastify.get("/users/:id/provenance", { preHandler: [requireAuth, requireOwner] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, username: true, email: true, emailVerifiedAt: true, createdAt: true, signupCountry: true, signupIp: true,
        signupUserAgent: true, signupDevice: true, signupClient: true, ageBracket: true, birthDate: true, isMinor: true,
        ageReview: true, ageReviewReason: true },
    });
    if (!user) throw new NotFoundError("User not found");
    const [tokens, pushTokens, flags] = await Promise.all([
      prisma.refreshToken.findMany({ where: { userId: id }, orderBy: { createdAt: "asc" }, take: 500,
        select: { userAgent: true, ipAddress: true, deviceFingerprint: true, createdAt: true, revokedAt: true, expiresAt: true } }),
      prisma.deviceToken.findMany({ where: { userId: id }, select: { app: true, platform: true, build: true, createdAt: true, lastSeenAt: true } }),
      prisma.accountFlag.findMany({ where: { userId: id }, orderBy: { createdAt: "desc" }, take: 50,
        select: { id: true, reasonCode: true, detail: true, createdAt: true, active: true, resolvedAt: true } }),
    ]);
    // One row per device (fingerprint, else user agent), newest last-seen first.
    const now = Date.now();
    const devices = new Map<string, { key: string; device: string; userAgent: string | null; ips: Set<string>; firstSeen: Date; lastSeen: Date; sessions: number; active: number; fingerprint: boolean }>();
    for (const t of tokens) {
      const key = t.deviceFingerprint ?? `ua:${t.userAgent ?? "unknown"}`;
      const d = devices.get(key) ?? { key, device: describeUserAgent(t.userAgent, null), userAgent: t.userAgent, ips: new Set<string>(),
        firstSeen: t.createdAt, lastSeen: t.createdAt, sessions: 0, active: 0, fingerprint: !!t.deviceFingerprint };
      if (t.ipAddress) d.ips.add(t.ipAddress);
      if (t.createdAt > d.lastSeen) { d.lastSeen = t.createdAt; d.userAgent = t.userAgent; d.device = describeUserAgent(t.userAgent, null); }
      d.sessions += 1;
      if (!t.revokedAt && t.expiresAt.getTime() > now) d.active += 1;
      devices.set(key, d);
    }
    const fingerprints = [...devices.values()].filter((d) => d.fingerprint).map((d) => d.key);
    if (user.signupDevice) fingerprints.push(user.signupDevice);
    const others = fingerprints.length
      ? await prisma.refreshToken.findMany({ where: { deviceFingerprint: { in: fingerprints }, userId: { not: id } }, distinct: ["userId"], take: 25,
          select: { user: { select: { id: true, username: true } } } })
      : [];
    await audit(request.userId!, "PROVENANCE_VIEW", "user", id, `@${user.username}`);
    return {
      signup: {
        at: user.createdAt.toISOString(), ip: user.signupIp, userAgent: user.signupUserAgent,
        device: user.signupUserAgent ? describeUserAgent(user.signupUserAgent, user.signupClient) : null,
        client: user.signupClient, country: user.signupCountry, recorded: !!(user.signupIp || user.signupUserAgent),
      },
      account: { email: user.email, emailVerified: !!user.emailVerifiedAt, ageBracket: user.ageBracket, birthDate: user.birthDate?.toISOString().slice(0, 10) ?? null,
        isMinor: user.isMinor, ageReview: user.ageReview, ageReviewReason: user.ageReviewReason },
      devices: [...devices.values()].sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime()).map((d) => ({
        device: d.device, userAgent: d.userAgent, ips: [...d.ips].slice(0, 10), firstSeen: d.firstSeen.toISOString(), lastSeen: d.lastSeen.toISOString(),
        sessions: d.sessions, active: d.active,
      })),
      apps: pushTokens.map((p) => ({ app: p.app, platform: p.platform, build: p.build, installedAt: p.createdAt.toISOString(), lastSeen: p.lastSeenAt.toISOString() })),
      otherAccountsOnTheseDevices: others.map((o) => o.user),
      flags: flags.map((f) => ({ ...f, createdAt: f.createdAt.toISOString(), resolvedAt: f.resolvedAt?.toISOString() ?? null })),
    };
  });

  /** A refused sign-up's provenance (IP, device, user agent). Owner-only, audited. */
  fastify.get("/flags/:id/provenance", { preHandler: [requireAuth, requireOwner] }, async (request) => {
    const { id } = request.params as { id: string };
    const f = await prisma.accountFlag.findUnique({ where: { id } });
    if (!f) throw new NotFoundError("Flag not found");
    const [sameDevice, sameIp] = await Promise.all([
      f.deviceHash ? prisma.accountFlag.count({ where: { deviceHash: f.deviceHash, id: { not: f.id } } }) : Promise.resolve(0),
      f.ipHash ? prisma.accountFlag.count({ where: { ipHash: f.ipHash, id: { not: f.id } } }) : Promise.resolve(0),
    ]);
    await audit(request.userId!, "PROVENANCE_VIEW", "flag", id, f.reasonCode);
    return {
      id: f.id, reasonCode: f.reasonCode, detail: f.detail, createdAt: f.createdAt.toISOString(),
      ip: f.ipAddress, userAgent: f.userAgent, device: f.userAgent ? describeUserAgent(f.userAgent, f.clientType) : null,
      country: f.country, client: f.clientType, purgedAt: f.provenancePurgedAt?.toISOString() ?? null,
      otherFlagsFromThisDevice: sameDevice, otherFlagsFromThisAddress: sameIp,
    };
  });
}
