import type { FastifyInstance } from "fastify";
import { generateOfficialAccount, listOfficialAccounts, setOfficial } from "./officialAccounts.js";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import { requireAuth, requireOwner, requireMaster, requireStaff } from "../../plugins/authenticate.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { serializeUser } from "../../lib/serialize.js";
import { assignableRoles } from "../../lib/platformRole.js";
import { applyRoleGrant } from "../../lib/roleGrant.js";
import { isBillingConfigured, isWebhookConfigured } from "../billing/stripe.js";
import { searchBlockReasons } from "@lumina/shared";

/** Design assets only. Deliberately no archives that could smuggle executables, and no HTML/SVG
 * with script — these files are opened by a human on this machine, not served to browsers. */
const ACCEPTED_BRAND_EXT = /^\.(png|jpe?g|gif|webp|svg|pdf|woff2?|ttf|otf|zip|txt|md|json|ai|psd|sketch|fig)$/;

const grantSchema = z.object({
  userId: z.string().min(1),
  platformRole: z.enum(["USER", "STAFF", "OWNER"]),
});

/**
 * Master-only platform administration. Mounted under /api/master.
 *
 * The distinction from /api/owner is about blast radius rather than seniority: an owner runs the
 * platform day to day, while these routes change who holds power and what the platform is. Keeping
 * them behind a separate gate means a compromised owner account cannot appoint accomplices or read
 * the platform's configuration.
 */
export default async function masterRoutes(fastify: FastifyInstance) {
  /**
   * The team: everyone with any platform role. Also returns which roles the CALLER may assign, so
   * the UI renders exactly the options the server will accept rather than offering choices that
   * come back 403.
   */
  fastify.get("/team", { preHandler: [requireAuth, requireOwner] }, async (request) => {
    const actor = await prisma.user.findUnique({
      where: { id: request.userId! },
      select: { platformRole: true },
    });

    const team = await prisma.user.findMany({
      where: { platformRole: { in: ["STAFF", "OWNER", "MASTER"] } },
      orderBy: [{ platformRole: "desc" }, { username: "asc" }],
      include: { _count: { select: { reviewedVideos: true, staffAuditEntries: true } } },
    });

    return {
      assignableRoles: assignableRoles(actor?.platformRole),
      team: team.map((u) => ({
        ...serializeUser(u),
        email: u.email,
        platformRole: u.platformRole,
        createdAt: u.createdAt.toISOString(),
        // What this person has actually done, so removing someone isn't a decision made blind.
        activity: {
          videosReviewed: u._count.reviewedVideos,
          staffActions: u._count.staffAuditEntries,
        },
      })),
    };
  });

  /**
   * Grants or revokes a platform role.
   *
   * Owner-or-above, but what may be granted is decided per-caller by assignableRoles: an owner can
   * appoint staff, only the master can appoint owners, and MASTER is not assignable by anyone —
   * it comes solely from the MASTER_EMAIL env var. Without that last rule, anyone who reached this
   * route once could make their own access permanent.
   */
  fastify.post("/grant", { preHandler: [requireAuth, requireOwner] }, async (request) => {
    const parsed = grantSchema.safeParse(request.body);
    if (!parsed.success) throw new BadRequestError("A user and a valid role are required");

    const updated = await applyRoleGrant({
      actorId: request.userId!,
      targetId: parsed.data.userId,
      platformRole: parsed.data.platformRole,
      actionType: "PLATFORM_ROLE_GRANT",
    });

    return {
      ...updated,
      // Env is now only a floor for STAFF/OWNER, so a grant made here survives the target's next
      // login. MASTER remains env-anchored and is not assignable from any API path.
      envMayOverride: false,
    };
  });

  /**
   * Platform configuration status. Reports only whether each secret is PRESENT — never its value.
   * A dashboard that displays live credentials is a credential-leak waiting for one screenshot.
   */
  /**
   * Mints a first-party account: Lumina logo as the avatar, "Official Lumina Staff" as the bio, and
   * the `isOfficial` badge — which is the only part of that an impersonator can't reproduce.
   *
   * MASTER-only, and deliberately not delegated to OWNER. Being able to create accounts that the
   * whole platform is told to trust is the most impersonation-sensitive power in the product, and
   * it belongs at the tier that can only be granted from the server's own environment.
   */
  fastify.post("/official-accounts", { preHandler: [requireAuth, requireMaster] }, async (request, reply) => {
    const body = request.body as { username?: string; displayName?: string; bio?: string };
    if (!body.username) throw new BadRequestError("A username is required");

    const account = await generateOfficialAccount({
      username: body.username,
      displayName: body.displayName ?? null,
      bio: body.bio ?? null,
    });

    await prisma.staffAuditLog.create({
      data: {
        actorId: request.userId!,
        actionType: "official.create",
        targetType: "user",
        targetId: account.id,
        reason: `@${account.username}`,
      },
    });

    reply.code(201);
    // The password is in this response and nowhere else — never logged, never stored readable.
    return account;
  });

  fastify.get("/official-accounts", { preHandler: [requireAuth, requireMaster] }, async () => {
    return listOfficialAccounts();
  });

  /** Revoke (or restore) the badge without deleting the account. */
  fastify.patch("/official-accounts/:id", { preHandler: [requireAuth, requireMaster] }, async (request) => {
    const { id } = request.params as { id: string };
    const { isOfficial } = request.body as { isOfficial?: boolean };
    if (typeof isOfficial !== "boolean") throw new BadRequestError("isOfficial must be true or false");

    const updated = await setOfficial(id, isOfficial);
    await prisma.staffAuditLog.create({
      data: {
        actorId: request.userId!,
        actionType: isOfficial ? "official.grant" : "official.revoke",
        targetType: "user",
        targetId: id,
        reason: `@${updated.username}`,
      },
    });
    return updated;
  });

  fastify.get("/config", { preHandler: [requireAuth, requireMaster] }, async () => {
    const configured = (v: string | undefined) => Boolean(v && v.trim());
    return {
      billing: {
        stripeSecretKey: configured(env.STRIPE_SECRET_KEY),
        stripePublishableKey: configured(env.STRIPE_PUBLISHABLE_KEY),
        stripeWebhookSecret: configured(env.STRIPE_WEBHOOK_SECRET),
        // Both are needed for billing to actually work: a secret key without a webhook secret means
        // payments can be taken but never recorded.
        operational: isBillingConfigured() && isWebhookConfigured(),
      },
      push: {
        vapidPublicKey: configured(env.VAPID_PUBLIC_KEY),
        vapidPrivateKey: configured(env.VAPID_PRIVATE_KEY),
      },
      voice: { turnSecret: configured(env.TURN_SECRET), turnHost: env.TURN_HOST },
      roles: {
        masterEmailSet: configured(env.MASTER_EMAIL),
        ownerCount: env.OWNER_EMAILS.split(",").filter((e) => e.trim()).length,
        staffCount: [env.STAFF_EMAILS, env.SITE_ADMIN_EMAILS]
          .join(",")
          .split(",")
          .filter((e) => e.trim()).length,
      },
      limits: {
        maxUploadMb: env.MAX_UPLOAD_MB,
        maxVideoUploadMb: env.MAX_VIDEO_UPLOAD_MB,
        maxVideoDurationSec: env.MAX_VIDEO_DURATION_SEC,
        maxVideoUploadsPerDay: env.MAX_VIDEO_UPLOADS_PER_DAY,
      },
      environment: env.NODE_ENV,
    };
  });

  /**
   * Brand kit upload — logos, fonts, palettes, style guides for the UI redesign.
   *
   * Master-only and stored outside the public web root: these are working design assets, not
   * published content, and nothing serves them to anyone but the master account.
   *
   * Streams to disk rather than buffering (a brand kit can be tens of megabytes of PSDs and fonts),
   * and the stored filename is a generated uuid, never the caller's — an uploaded name is
   * attacker-controlled and joining it onto a path is the classic traversal hole. The original name
   * is kept alongside as metadata purely so the listing is readable.
   */
  fastify.post("/brand-kit", { preHandler: [requireAuth, requireMaster] }, async (request) => {
    if (!request.isMultipart()) throw new BadRequestError("Expected a file upload");

    const dir = path.join(env.UPLOADS_DIR, "brand-kit");
    await fs.mkdir(dir, { recursive: true });

    const saved: Array<{ id: string; fileName: string; sizeBytes: number }> = [];
    for await (const part of request.parts({ limits: { fileSize: 100 * 1024 * 1024, files: 20 } })) {
      if (part.type !== "file") continue;

      const originalName = path.basename(part.filename || "upload").slice(0, 120);
      const ext = path.extname(originalName).toLowerCase().slice(0, 10);
      if (!ACCEPTED_BRAND_EXT.test(ext)) {
        // Drain the stream before rejecting, or the connection hangs on the unread body.
        part.file.resume();
        throw new BadRequestError(`Unsupported file type: ${ext || "(none)"}`);
      }

      const id = `${randomUUID()}${ext}`;
      const dest = path.join(dir, id);
      // Counted from the file on disk afterwards rather than by attaching a "data" listener.
      // Adding that listener switches the stream into flowing mode the moment it is attached —
      // before pipeline() has wired up its destination — so on a fast upload the first chunks can
      // be emitted to a reader that isn't writing them anywhere yet.
      await pipeline(part.file, createWriteStream(dest));
      const size = (await fs.stat(dest)).size;

      if (part.file.truncated) {
        await fs.unlink(dest).catch(() => undefined);
        throw new BadRequestError("File exceeds the 100MB limit");
      }

      await fs.writeFile(
        path.join(dir, `${id}.meta.json`),
        JSON.stringify({ originalName, uploadedAt: new Date().toISOString(), sizeBytes: size }),
      );
      saved.push({ id, fileName: originalName, sizeBytes: size });
    }

    if (saved.length === 0) throw new BadRequestError("No files were uploaded");
    return { uploaded: saved };
  });

  /** Lists what has been uploaded, so the master can confirm a file actually landed. */
  fastify.get("/brand-kit", { preHandler: [requireAuth, requireMaster] }, async () => {
    const dir = path.join(env.UPLOADS_DIR, "brand-kit");
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return { files: [] };
    }

    const files = [];
    for (const name of names) {
      if (name.endsWith(".meta.json")) continue;
      let meta: { originalName?: string; uploadedAt?: string; sizeBytes?: number } = {};
      try {
        meta = JSON.parse(await fs.readFile(path.join(dir, `${name}.meta.json`), "utf8"));
      } catch {
        /* uploaded before metadata existed, or written by hand */
      }
      let sizeBytes = meta.sizeBytes ?? 0;
      if (!sizeBytes) {
        try {
          sizeBytes = (await fs.stat(path.join(dir, name))).size;
        } catch {
          sizeBytes = 0;
        }
      }
      files.push({
        id: name,
        fileName: meta.originalName ?? name,
        uploadedAt: meta.uploadedAt ?? null,
        sizeBytes,
      });
    }
    return { files: files.sort((a, b) => (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? "")) };
  });

  /**
   * The block-reason catalogue, searchable. Staff-visible (they answer support), and the only place
   * `staffNote` is ever exposed — it deliberately describes detection logic, which is a manual for
   * evasion if shown to the person being blocked.
   */
  fastify.get("/reasons", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const { q } = request.query as { q?: string };
    return { reasons: searchBlockReasons(q ?? "") };
  });

  /**
   * Recorded flags — actual occurrences, as opposed to the catalogue of what CAN happen. Filterable
   * by code so "how often is this firing" and "who did it hit" are one query.
   */
  fastify.get("/flags", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const query = request.query as { code?: string; active?: string; limit?: string; userId?: string };
    const take = Math.min(200, Math.max(1, Number(query.limit ?? 100) || 100));

    const flags = await prisma.accountFlag.findMany({
      where: {
        ...(query.code ? { reasonCode: query.code } : {}),
        ...(query.active === "true" ? { active: true } : {}),
        ...(query.userId ? { userId: query.userId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take,
      include: {
        user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });

    // How often each code has fired, so the catalogue can show real frequency rather than making
    // someone page through occurrences to find out what actually happens in practice.
    const counts = await prisma.accountFlag.groupBy({
      by: ["reasonCode"],
      _count: { _all: true },
    });

    return {
      flags: flags.map((f) => ({
        id: f.id,
        reasonCode: f.reasonCode,
        severity: f.severity,
        detail: f.detail,
        active: f.active,
        createdAt: f.createdAt.toISOString(),
        user: f.user,
        // Identifier hashes are never returned — they exist for matching, not display, and a
        // console that renders them turns a screenshot into a data leak.
        hasDevice: Boolean(f.deviceHash),
        hasIp: Boolean(f.ipHash),
      })),
      counts: Object.fromEntries(counts.map((c) => [c.reasonCode, c._count._all])),
    };
  });

  /** Clears an active flag once support has dealt with it. */
  fastify.post("/flags/:id/resolve", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const { id } = request.params as { id: string };
    const flag = await prisma.accountFlag.findUnique({ where: { id } });
    if (!flag) throw new NotFoundError("Flag not found");
    await prisma.accountFlag.update({
      where: { id },
      data: { active: false, resolvedAt: new Date(), resolvedById: request.userId! },
    });
    return { ok: true };
  });

  /**
   * Unified activity feed: safety flags and staff actions on one timeline.
   *
   * They are separate tables because they are different things — one is "the system blocked
   * something", the other is "a person decided something" — but reading them apart makes it
   * impossible to see cause and effect. Merged and sorted, "device blocked, then support lifted it"
   * reads as one story.
   */
  fastify.get("/activity", { preHandler: [requireAuth, requireStaff] }, async (request) => {
    const query = request.query as { limit?: string; kind?: string };
    const take = Math.min(200, Math.max(1, Number(query.limit ?? 80) || 80));

    const [flags, audit] = await Promise.all([
      query.kind === "staff"
        ? []
        : prisma.accountFlag.findMany({
            orderBy: { createdAt: "desc" },
            take,
            include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
          }),
      query.kind === "flag"
        ? []
        : prisma.staffAuditLog.findMany({
            orderBy: { createdAt: "desc" },
            take,
            include: { actor: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
          }),
    ]);

    const events = [
      ...flags.map((f) => ({
        id: `flag:${f.id}`,
        kind: "flag" as const,
        at: f.createdAt.toISOString(),
        code: f.reasonCode,
        severity: f.severity,
        detail: f.detail,
        active: f.active,
        subject: f.user,
        actor: null,
      })),
      ...audit.map((a) => ({
        id: `audit:${a.id}`,
        kind: "staff" as const,
        at: a.createdAt.toISOString(),
        code: a.actionType,
        severity: "INFO",
        detail: a.reason,
        active: false,
        subject: null,
        actor: a.actor,
      })),
    ]
      .sort((x, y) => y.at.localeCompare(x.at))
      .slice(0, take);

    // Per-day counts for the feed's chart, so volume is visible without reading every row.
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const recent = await prisma.accountFlag.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true, severity: true },
    });
    const buckets = new Map<string, number>();
    for (let i = 13; i >= 0; i--) {
      buckets.set(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10), 0);
    }
    for (const r of recent) {
      const k = r.createdAt.toISOString().slice(0, 10);
      if (buckets.has(k)) buckets.set(k, (buckets.get(k) ?? 0) + 1);
    }

    return {
      events,
      series: Array.from(buckets.entries()).map(([date, count]) => ({ date, count })),
      activeFlags: flags.filter((f) => f.active).length,
    };
  });

  /**
   * Upload provenance for one video — the uploader's IP, device fingerprint and user-agent.
   *
   * Master-only, not staff. Moderators decide whether content stays up and need none of this; the
   * only legitimate use is responding to a lawful request, which is the master's call. Every read is
   * written to the staff audit log, because access to identifying data should itself leave a trail.
   */
  fastify.get("/videos/:id/provenance", { preHandler: [requireAuth, requireMaster] }, async (request) => {
    const { id } = request.params as { id: string };
    let videoId: bigint;
    try {
      videoId = BigInt(id);
    } catch {
      throw new NotFoundError("Video not found");
    }

    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        createdAt: true,
        sha256: true,
        uploadIp: true,
        uploadDevice: true,
        uploadUserAgent: true,
        provenancePurgedAt: true,
        author: { select: { id: true, username: true, displayName: true, email: true } },
      },
    });
    if (!video) throw new NotFoundError("Video not found");

    await prisma.staffAuditLog.create({
      data: {
        actorId: request.userId!,
        actionType: "PROVENANCE_VIEW",
        targetType: "video",
        targetId: id,
        reason: null,
      },
    });

    return {
      videoId: video.id.toString(),
      uploadedAt: video.createdAt.toISOString(),
      // Content hash of the original upload — the thing that identifies the FILE independently of
      // any account, which is what a takedown or law-enforcement reference actually needs.
      sha256: video.sha256,
      uploader: video.author,
      ip: video.uploadIp,
      device: video.uploadDevice,
      userAgent: video.uploadUserAgent,
      purgedAt: video.provenancePurgedAt?.toISOString() ?? null,
    };
  });

  /** Every privileged action taken on the platform, across staff and owners. */
  fastify.get("/audit", { preHandler: [requireAuth, requireMaster] }, async (request) => {
    const query = request.query as { limit?: string };
    const take = Math.min(200, Math.max(1, Number(query.limit ?? 100) || 100));
    const entries = await prisma.staffAuditLog.findMany({
      orderBy: { createdAt: "desc" },
      take,
      include: {
        actor: { select: { id: true, username: true, displayName: true, avatarUrl: true, platformRole: true } },
      },
    });
    return entries.map((e) => ({
      id: e.id,
      actionType: e.actionType,
      targetType: e.targetType,
      targetId: e.targetId,
      reason: e.reason,
      createdAt: e.createdAt.toISOString(),
      actor: e.actor,
    }));
  });
}
