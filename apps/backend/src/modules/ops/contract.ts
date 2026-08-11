import { z } from "zod";

/**
 * The wire contract between the host agent and the API.
 *
 * Kept in one file, validated on the way in, and deliberately strict: the agent is the one caller
 * that is trusted enough to change what an owner sees, so a malformed or oversized report should
 * be rejected outright rather than stored and rendered.
 */

/** Every action the platform is willing to express. The agent holds the same list independently
 * and re-checks it — this one exists so a bad request is refused before it is ever queued, not so
 * the agent can rely on it. Deliberately short: none of these can run arbitrary commands, and
 * nothing here touches anything outside Lumina's own Compose project. */
export const OPS_ACTIONS = ["restart", "start", "stop"] as const;
export type OpsAction = (typeof OPS_ACTIONS)[number];

/** Compose services the agent will act on. `postgres` is intentionally absent: restarting the
 * database from a web dashboard is a foot-gun with no upside — the one time you want it, you want
 * a shell and your full attention, not a button next to "view logs". */
export const OPS_TARGETS = ["backend", "worker", "frontend", "redis", "coturn"] as const;
export type OpsTarget = (typeof OPS_TARGETS)[number];

export const containerSchema = z.object({
  name: z.string().max(120),
  service: z.string().max(120),
  state: z.string().max(40),
  /** "healthy" | "unhealthy" | "starting" | "" — Compose reports empty for services with no
   * healthcheck, which is NOT the same as unhealthy and must not be rendered as red. */
  health: z.string().max(40),
  status: z.string().max(200),
  cpuPercent: z.number().nullable(),
  memBytes: z.number().nullable(),
  memLimitBytes: z.number().nullable(),
  restartCount: z.number().int().nullable(),
  startedAt: z.string().max(64).nullable(),
});

export const snapshotSchema = z.object({
  agentId: z.string().min(1).max(64),
  agentVersion: z.string().max(32),
  /** The agent's own clock, kept alongside the server's receipt time so a drifting host is
   * visible rather than confusing. */
  reportedAt: z.string().max(64),
  host: z.object({
    hostname: z.string().max(120),
    uptimeSeconds: z.number(),
    loadAverage: z.array(z.number()).max(3),
    cpuCount: z.number().int(),
    memTotalBytes: z.number(),
    memAvailableBytes: z.number(),
    diskTotalBytes: z.number().nullable(),
    diskFreeBytes: z.number().nullable(),
  }),
  containers: z.array(containerSchema).max(40),
  /** Populated only when the agent could not reach Docker. A report still arrives, so "the agent
   * is alive but blind" is distinguishable from "the agent is gone". */
  dockerError: z.string().max(500).nullable().optional(),
});

export type OpsSnapshotPayload = z.infer<typeof snapshotSchema>;
export type OpsContainer = z.infer<typeof containerSchema>;

export const commandResultSchema = z.object({
  ok: z.boolean(),
  output: z.string().max(2000),
});

export const enqueueSchema = z.object({
  action: z.enum(OPS_ACTIONS),
  target: z.enum(OPS_TARGETS),
});

/** How long a queued command stays worth running. A restart requested twenty minutes ago that only
 * now reaches a returning agent is almost never still what anyone wanted, and running it then is
 * surprising in the worst way. */
export const COMMAND_TTL_MS = 5 * 60 * 1000;

/** Beyond this the agent is reported as missing rather than as reporting old numbers. Three times
 * the agent's own 30s cycle, so one dropped report is not an alarm. */
export const AGENT_STALE_MS = 95 * 1000;

/** Snapshot retention. At one report every 30s this is roughly 24 hours, which is the window where
 * "what happened just before it fell over" is actually answerable. */
export const SNAPSHOT_RETENTION = 2_900;
