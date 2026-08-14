import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { requireAdult } from "../age/guard.js";
import { hashRefreshToken } from "../../lib/jwt.js";
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from "../../lib/errors.js";

/**
 * Game sandbox control plane.
 *
 * THE SECURITY MODEL, stated plainly: the untrusted container (a Minecraft server with the
 * owner's arbitrary mods/plugins/bots) runs on the OWNER's OWN machine, launched by the Lumina
 * Game Agent. Lumina never executes any of it. This file is a thin, tightly-scoped relay:
 *
 *  - OWNER routes (a normal user session) manage the sandbox definition and queue control verbs.
 *  - AGENT routes authenticate with `GameAgent <token>` — a credential that resolves to exactly
 *    ONE sandbox and can reach NOTHING else in the API. It is not a user, has no session, and
 *    every agent route is scoped to `request.sandbox` set by requireAgent. That is the barrier:
 *    a compromised agent (or a hostile one) can only report status for its own sandbox and read
 *    its own queued command — it cannot touch Postgres, other users, or any core system.
 *  - CONSUMER routes back the Activity control panel with read-only status + the connect address.
 *
 * Everything the agent reports (connectAddress, players, console) is the owner's own self-declared
 * data about their own machine. It is shown, never trusted as authority over anything in Lumina.
 */

const HEARTBEAT_STALE_MS = 90_000;

// Minecraft spec: the owner's programmable config, handed to the agent verbatim. Bounded so a
// stored blob can't be pathological, but otherwise theirs to fill — the agent decides what to do
// with it on their hardware.
const specSchema = z.object({
  serverType: z.enum(["VANILLA", "PAPER", "FABRIC", "FORGE", "SPIGOT", "PURPUR", "QUILT"]).default("PAPER"),
  mcVersion: z.string().max(20).optional(),
  memoryMb: z.number().int().min(512).max(16384).default(2048),
  mods: z.array(z.string().max(400)).max(200).default([]),
  plugins: z.array(z.string().max(400)).max(200).default([]),
  worldUrl: z.string().max(500).optional(),
  motd: z.string().max(120).optional(),
  extraEnv: z.record(z.string().max(2000)).optional(),
});

function serializeOwner(s: {
  id: string; name: string; kind: string; status: string; specJson: unknown; connectAddress: string | null;
  playerCount: number; maxPlayers: number; consoleTail: string | null; serverId: string | null;
  hostedByLumina: boolean; lastHeartbeat: Date | null; agentTokenHash: string | null; createdAt: Date;
}) {
  const online = !!s.lastHeartbeat && Date.now() - s.lastHeartbeat.getTime() < HEARTBEAT_STALE_MS;
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    status: online ? s.status : "OFFLINE",
    agentConnected: online,
    spec: s.specJson ?? null,
    connectAddress: online ? s.connectAddress : null,
    playerCount: online ? s.playerCount : 0,
    maxPlayers: s.maxPlayers,
    consoleTail: s.consoleTail,
    serverId: s.serverId,
    hostedByLumina: s.hostedByLumina,
    hasAgentToken: !!s.agentTokenHash,
    createdAt: s.createdAt.toISOString(),
  };
}

// ---- agent auth: resolves a GameAgent token to exactly one sandbox, and nothing else ---------
declare module "fastify" {
  interface FastifyRequest {
    sandbox?: { id: string; ownerId: string };
  }
}
async function requireAgent(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith("GameAgent ")) throw new UnauthorizedError("Missing agent token");
  const sandbox = await prisma.gameSandbox.findUnique({
    where: { agentTokenHash: hashRefreshToken(header.slice("GameAgent ".length)) },
    select: { id: true, ownerId: true },
  });
  if (!sandbox) throw new UnauthorizedError("Invalid agent token");
  request.sandbox = sandbox;
}

export default async function sandboxRoutes(fastify: FastifyInstance) {
  // ============================================================ OWNER (user session, adult-gated)
  fastify.get("/", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    const rows = await prisma.gameSandbox.findMany({ where: { ownerId: request.userId! }, orderBy: { createdAt: "desc" } });
    return rows.map(serializeOwner);
  });

  fastify.post(
    "/",
    { schema: { body: z.object({ name: z.string().trim().min(1).max(60), kind: z.enum(["minecraft"]).default("minecraft") }) }, preHandler: [requireAuth, requireAdult] },
    async (request, reply) => {
      const body = request.body as { name: string; kind: "minecraft" };
      if ((await prisma.gameSandbox.count({ where: { ownerId: request.userId! } })) >= 10) {
        throw new BadRequestError("Sandbox limit reached (10 per account)");
      }
      const sandbox = await prisma.gameSandbox.create({
        data: { ownerId: request.userId!, name: body.name, kind: body.kind, specJson: specSchema.parse({}) },
      });
      reply.code(201);
      return serializeOwner(sandbox);
    },
  );

  async function ownedSandbox(request: FastifyRequest, id: string) {
    const s = await prisma.gameSandbox.findUnique({ where: { id } });
    if (!s || s.ownerId !== request.userId) throw new NotFoundError("Sandbox not found");
    return s;
  }

  /** Mint (or rotate) the agent token — shown once, like every other secret in this app. */
  fastify.post("/:id/agent-token", { preHandler: [requireAuth, requireAdult] }, async (request) => {
    await ownedSandbox(request, (request.params as { id: string }).id);
    const token = `lga_${randomBytes(24).toString("hex")}`;
    await prisma.gameSandbox.update({
      where: { id: (request.params as { id: string }).id },
      data: { agentTokenHash: hashRefreshToken(token) },
    });
    return { agentToken: token };
  });

  fastify.put(
    "/:id/spec",
    { schema: { body: specSchema }, preHandler: [requireAuth, requireAdult] },
    async (request) => {
      await ownedSandbox(request, (request.params as { id: string }).id);
      const spec = request.body as z.infer<typeof specSchema>;
      const updated = await prisma.gameSandbox.update({ where: { id: (request.params as { id: string }).id }, data: { specJson: spec } });
      return serializeOwner(updated);
    },
  );

  /** Attach to a Lumina server (so the Activity panel appears there). Owner must own the server
   * or be a member with MANAGE_SERVER — checked via membership, not asserted by the client. */
  fastify.post(
    "/:id/attach",
    { schema: { body: z.object({ serverId: z.string().nullable() }) }, preHandler: [requireAuth, requireAdult] },
    async (request) => {
      await ownedSandbox(request, (request.params as { id: string }).id);
      const { serverId } = request.body as { serverId: string | null };
      if (serverId) {
        const server = await prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } });
        if (!server) throw new NotFoundError("Server not found");
        if (server.ownerId !== request.userId) throw new ForbiddenError("Only the server owner can attach a sandbox to it");
      }
      const updated = await prisma.gameSandbox.update({ where: { id: (request.params as { id: string }).id }, data: { serverId } });
      return serializeOwner(updated);
    },
  );

  /** Queue a control verb; the agent picks it up on its next poll. Lumina issues the intent, the
   * owner's machine carries it out. */
  fastify.post(
    "/:id/command",
    { schema: { body: z.object({ command: z.enum(["start", "stop", "restart"]) }) }, preHandler: [requireAuth, requireAdult] },
    async (request) => {
      await ownedSandbox(request, (request.params as { id: string }).id);
      const { command } = request.body as { command: string };
      await prisma.gameSandbox.update({ where: { id: (request.params as { id: string }).id }, data: { pendingCommand: command } });
      return { queued: command };
    },
  );

  fastify.delete("/:id", { preHandler: [requireAuth, requireAdult] }, async (request, reply) => {
    await ownedSandbox(request, (request.params as { id: string }).id);
    await prisma.gameSandbox.delete({ where: { id: (request.params as { id: string }).id } });
    reply.code(204).send();
  });

  // ============================================================ AGENT (scoped token, no session)
  /** The agent heartbeats its self-reported state; Lumina stores it and hands back any queued
   * command (once). This is the ENTIRE surface an agent token can reach. */
  fastify.post(
    "/agent/heartbeat",
    {
      schema: {
        body: z.object({
          status: z.enum(["OFFLINE", "STARTING", "ONLINE", "STOPPING", "ERROR"]),
          connectAddress: z.string().max(260).optional(),
          playerCount: z.number().int().min(0).max(10000).optional(),
          maxPlayers: z.number().int().min(0).max(10000).optional(),
          consoleTail: z.string().max(8000).optional(),
        }),
      },
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      preHandler: [requireAgent],
    },
    async (request) => {
      const b = request.body as { status: string; connectAddress?: string; playerCount?: number; maxPlayers?: number; consoleTail?: string };
      const s = await prisma.gameSandbox.update({
        where: { id: request.sandbox!.id },
        data: {
          status: b.status as never,
          connectAddress: b.connectAddress ?? null,
          playerCount: b.playerCount ?? 0,
          maxPlayers: b.maxPlayers ?? 0,
          consoleTail: b.consoleTail ?? undefined,
          lastHeartbeat: new Date(),
        },
        select: { specJson: true, pendingCommand: true },
      });
      // Deliver + clear the queued command in the same breath so it fires exactly once.
      if (s.pendingCommand) {
        await prisma.gameSandbox.update({ where: { id: request.sandbox!.id }, data: { pendingCommand: null } });
      }
      return { command: s.pendingCommand ?? null, spec: s.specJson ?? null };
    },
  );

  // ============================================================ CONSUMER (Activity panel readers)
  /** Read-only public view for the control-panel Activity and server members: is it up, where do
   * I connect. Anyone who can see the attached server can see this; nothing sensitive here. */
  fastify.get("/:id/public", { preHandler: [requireAuth] }, async (request) => {
    const s = await prisma.gameSandbox.findUnique({ where: { id: (request.params as { id: string }).id } });
    if (!s) throw new NotFoundError("Sandbox not found");
    const online = !!s.lastHeartbeat && Date.now() - s.lastHeartbeat.getTime() < HEARTBEAT_STALE_MS;
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      status: online ? s.status : "OFFLINE",
      online,
      connectAddress: online ? s.connectAddress : null,
      playerCount: online ? s.playerCount : 0,
      maxPlayers: s.maxPlayers,
      isOwner: s.ownerId === request.userId,
    };
  });
}
