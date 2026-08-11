import type { FastifyInstance, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import { requireAuth, requireOwner } from "../../plugins/authenticate.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import {
  snapshotSchema,
  commandResultSchema,
  enqueueSchema,
  COMMAND_TTL_MS,
  AGENT_STALE_MS,
  SNAPSHOT_RETENTION,
  type OpsSnapshotPayload,
} from "./contract.js";
import { noteSnapshot } from "./alerts.js";

/**
 * Lumina Control. Mounted under /api/ops.
 *
 * Two audiences with completely different auth:
 *
 *  - The **agent** (`POST /report`, `POST /commands/:id/result`) authenticates with a shared
 *    secret. It is not a user, has no session, and is deliberately not routed through requireAuth —
 *    it must keep working when the database is fine but every human is logged out.
 *  - The **owner console** (everything else) is `requireOwner`, i.e. a real signed-in account at
 *    the owner tier.
 *
 * The agent never receives anything except its own queued commands, so this endpoint being reached
 * by someone holding the secret leaks no user data.
 */
export default async function opsRoutes(fastify: FastifyInstance) {
  fastify.post("/report", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request) => {
    assertAgent(request);

    const parsed = snapshotSchema.safeParse(request.body);
    if (!parsed.success) throw new BadRequestError("Malformed agent report");
    const payload = parsed.data;

    await prisma.opsSnapshot.create({
      data: { agentId: payload.agentId, payload: payload as unknown as object },
    });

    // Alerting happens on the way in, not on a timer: the moment a service goes unhealthy is the
    // moment worth telling someone about, and a cron that notices six minutes later is a
    // materially worse product.
    await noteSnapshot(payload);

    // Prune here rather than in a scheduled job. This table only grows when this endpoint is
    // called, so the write path is exactly the right place to bound it, and it needs no second
    // moving part that can silently stop.
    await prune(payload.agentId);

    // Report and pull work in one round trip. A separate poll would double the request rate for
    // no benefit and open a window where the agent has reported but not yet asked for commands.
    const now = new Date();
    await prisma.opsCommand.updateMany({
      where: {
        agentId: payload.agentId,
        status: "QUEUED",
        createdAt: { lt: new Date(now.getTime() - COMMAND_TTL_MS) },
      },
      data: { status: "EXPIRED", finishedAt: now, result: "Not claimed within its window" },
    });

    const queued = await prisma.opsCommand.findMany({
      where: { agentId: payload.agentId, status: "QUEUED" },
      orderBy: { createdAt: "asc" },
      take: 5,
    });
    if (queued.length > 0) {
      await prisma.opsCommand.updateMany({
        where: { id: { in: queued.map((c) => c.id) } },
        data: { status: "RUNNING", claimedAt: now },
      });
    }

    return { commands: queued.map((c) => ({ id: c.id, action: c.action, target: c.target })) };
  });

  fastify.post("/commands/:id/result", async (request) => {
    assertAgent(request);
    const { id } = request.params as { id: string };
    const parsed = commandResultSchema.safeParse(request.body);
    if (!parsed.success) throw new BadRequestError("Malformed command result");

    const command = await prisma.opsCommand.findUnique({ where: { id } });
    if (!command) throw new NotFoundError("Unknown command");
    // Only a claimed command can be completed. Without this, a replayed result could flip an
    // already-expired command back to succeeded and make the log lie about what ran.
    if (command.status !== "RUNNING") throw new BadRequestError("That command is not running");

    await prisma.opsCommand.update({
      where: { id },
      data: {
        status: parsed.data.ok ? "SUCCEEDED" : "FAILED",
        finishedAt: new Date(),
        result: parsed.data.output.slice(0, 2000),
      },
    });
    return { ok: true };
  });

  /** The dashboard's single read: latest state, whether the agent is actually alive, and what has
   * been asked of it recently. */
  fastify.get("/status", { preHandler: [requireAuth, requireOwner] }, async () => {
    const latest = await prisma.opsSnapshot.findFirst({ orderBy: { id: "desc" } });
    const commands = await prisma.opsCommand.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { requestedBy: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    });

    const ageMs = latest ? Date.now() - latest.createdAt.getTime() : null;
    return {
      // `agentOnline: false` with a real `lastSeenAt` is the honest shape. Returning the last
      // snapshot with no liveness flag would render a dead host as a healthy one.
      agentOnline: ageMs !== null && ageMs < AGENT_STALE_MS,
      lastSeenAt: latest?.createdAt.toISOString() ?? null,
      snapshot: (latest?.payload as OpsSnapshotPayload | undefined) ?? null,
      commands: commands.map((c) => ({
        id: c.id,
        action: c.action,
        target: c.target,
        status: c.status,
        result: c.result,
        createdAt: c.createdAt.toISOString(),
        finishedAt: c.finishedAt?.toISOString() ?? null,
        requestedBy: c.requestedBy,
      })),
    };
  });

  /** Downsampled series for the charts. Reads the JSON payloads and projects only the few numbers
   * a graph needs, so a day of history isn't shipped to a browser in full. */
  fastify.get("/history", { preHandler: [requireAuth, requireOwner] }, async (request) => {
    const { hours } = request.query as { hours?: string };
    const windowHours = Math.min(24, Math.max(1, Number(hours) || 6));
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    const rows = await prisma.opsSnapshot.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { id: "asc" },
      select: { createdAt: true, payload: true },
    });

    // Aim for ~120 points regardless of window, so the chart is the same weight at 1h and 24h.
    const step = Math.max(1, Math.ceil(rows.length / 120));
    const points = rows
      .filter((_, i) => i % step === 0)
      .map((r) => {
        const p = r.payload as unknown as OpsSnapshotPayload;
        const memUsed = p.host.memTotalBytes - p.host.memAvailableBytes;
        return {
          at: r.createdAt.toISOString(),
          load1: p.host.loadAverage[0] ?? 0,
          memPercent: p.host.memTotalBytes > 0 ? (memUsed / p.host.memTotalBytes) * 100 : 0,
          diskPercent:
            p.host.diskTotalBytes && p.host.diskFreeBytes !== null
              ? ((p.host.diskTotalBytes - p.host.diskFreeBytes) / p.host.diskTotalBytes) * 100
              : null,
          unhealthy: p.containers.filter((c) => c.health === "unhealthy" || c.state !== "running").length,
        };
      });

    return { windowHours, points };
  });

  fastify.post("/commands", { preHandler: [requireAuth, requireOwner] }, async (request, reply) => {
    const parsed = enqueueSchema.safeParse(request.body);
    // The zod enums are the allowlist. Anything not on it never becomes a row, which means the
    // agent is never even asked — defence in depth rather than relying on the agent alone.
    if (!parsed.success) throw new BadRequestError("That isn't an action Lumina Control can take");

    const latest = await prisma.opsSnapshot.findFirst({ orderBy: { id: "desc" } });
    if (!latest || Date.now() - latest.createdAt.getTime() >= AGENT_STALE_MS) {
      // Refusing up front rather than queueing into the void: a command that sits QUEUED against a
      // dead agent looks like it worked and then quietly expires.
      throw new BadRequestError("The control agent isn't reporting — nothing would pick this up");
    }

    const command = await prisma.opsCommand.create({
      data: {
        agentId: latest.agentId,
        action: parsed.data.action,
        target: parsed.data.target,
        requestedById: request.userId!,
      },
    });

    // Every action against infrastructure is recorded in the same append-only log as moderation
    // decisions. "Who restarted the backend at 3am" is exactly the question this has to answer.
    await prisma.staffAuditLog.create({
      data: {
        actorId: request.userId!,
        actionType: "ops.command",
        targetType: "service",
        targetId: parsed.data.target,
        reason: parsed.data.action,
      },
    });

    reply.code(202);
    return { id: command.id, status: command.status };
  });
}

/**
 * Shared-secret auth for the agent.
 *
 * timingSafeEqual, not `===`: this compares an attacker-supplied string against a secret, and a
 * short-circuiting comparison leaks its length and prefix a byte at a time. The length is checked
 * first because timingSafeEqual throws on a mismatch.
 */
function assertAgent(request: FastifyRequest): void {
  const configured = env.OPS_AGENT_SECRET;
  // Unset means the feature is off, not that everyone is allowed in.
  if (!configured) throw new ForbiddenError("Lumina Control is not configured");

  const presented = request.headers["x-lumina-agent-secret"];
  if (typeof presented !== "string") throw new ForbiddenError("Not authorized");

  const a = Buffer.from(presented);
  const b = Buffer.from(configured);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenError("Not authorized");
}

async function prune(agentId: string): Promise<void> {
  const cutoff = await prisma.opsSnapshot.findFirst({
    where: { agentId },
    orderBy: { id: "desc" },
    skip: SNAPSHOT_RETENTION,
    select: { id: true },
  });
  if (cutoff) {
    await prisma.opsSnapshot.deleteMany({ where: { agentId, id: { lte: cutoff.id } } });
  }
}
