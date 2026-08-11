import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";
import { sendPushToUser } from "../../lib/push.js";
import type { OpsSnapshotPayload } from "./contract.js";

/**
 * Turns the snapshot stream into notifications.
 *
 * A dashboard only helps someone who is already looking at it, and nobody watches a dashboard at
 * 3am. The point of this file is that the failure comes to you.
 *
 * Two rules keep it from becoming noise you learn to ignore, which is the normal way alerting
 * dies:
 *
 * 1. **Alert on transitions, not on states.** A service that has been down for an hour is one
 *    alert, not one hundred and twenty. The previous state lives in Redis, and losing it (a
 *    restart, a flush) costs at most one duplicate alert — which is why it is fine for this
 *    specifically to live in a store with no persistence.
 * 2. **Recovery is also an alert.** Being told something broke and never being told it came back
 *    trains you to go and check anyway, which defeats the purpose.
 */

const STATE_KEY = "ops:alert-state:v1";
/** Even a genuinely flapping service can only page once per this window, per subject. */
const COOLDOWN_SEC = 15 * 60;

/** Disk is the one resource on this box that fails slowly enough to be preventable — and video is
 * what fills it. 90% is late enough not to nag and early enough to act on. */
const DISK_ALERT_PERCENT = 90;

type Health = "ok" | "bad";

export async function noteSnapshot(payload: OpsSnapshotPayload): Promise<void> {
  const current = new Map<string, { health: Health; detail: string }>();

  for (const c of payload.containers) {
    // An empty `health` means the service declares no healthcheck, which is not the same as
    // unhealthy — coturn has none and would otherwise alert forever.
    const bad = c.state !== "running" || c.health === "unhealthy";
    current.set(`service:${c.service}`, {
      health: bad ? "bad" : "ok",
      detail: bad ? `${c.service} is ${c.health || c.state}` : `${c.service} is healthy again`,
    });
  }

  if (payload.host.diskTotalBytes && payload.host.diskFreeBytes !== null) {
    const usedPercent =
      ((payload.host.diskTotalBytes - payload.host.diskFreeBytes) / payload.host.diskTotalBytes) * 100;
    const bad = usedPercent >= DISK_ALERT_PERCENT;
    current.set("host:disk", {
      health: bad ? "bad" : "ok",
      detail: bad
        ? `Disk is ${usedPercent.toFixed(0)}% full`
        : `Disk is back under ${DISK_ALERT_PERCENT}% (${usedPercent.toFixed(0)}%)`,
    });
  }

  if (payload.dockerError) {
    current.set("agent:docker", { health: "bad", detail: "The control agent cannot reach Docker" });
  } else {
    current.set("agent:docker", { health: "ok", detail: "The control agent can see Docker again" });
  }

  const previous = await readPrevious();
  const changed: Array<{ key: string; health: Health; detail: string }> = [];

  for (const [key, state] of current) {
    // A subject seen for the first time is treated as previously OK, so a first report from an
    // already-broken service still alerts, while a first report from a healthy one stays quiet.
    const before = previous[key] ?? "ok";
    if (before !== state.health) changed.push({ key, ...state });
  }

  const next: Record<string, Health> = {};
  for (const [key, state] of current) next[key] = state.health;
  await writeState(next);

  if (changed.length === 0) return;

  const owners = await prisma.user.findMany({
    where: { platformRole: { in: ["OWNER", "MASTER"] } },
    select: { id: true },
  });

  for (const change of changed) {
    if (!(await claimCooldown(change.key))) continue;
    for (const owner of owners) {
      // Fire-and-forget, matching how every other push in this codebase is dispatched — an alert
      // that fails to deliver must never take down the report that triggered it.
      void sendPushToUser(owner.id, {
        title: change.health === "bad" ? "Lumina: something needs attention" : "Lumina: recovered",
        body: change.detail,
        url: "/owner/infrastructure",
        tag: `ops-${change.key}`,
      });
    }
  }
}

async function readPrevious(): Promise<Record<string, Health>> {
  try {
    const raw = await redis.get(STATE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Health>) : {};
  } catch {
    return {};
  }
}

async function writeState(state: Record<string, Health>): Promise<void> {
  try {
    // A TTL far longer than the report interval: if reports stop entirely, the state eventually
    // clears rather than persisting a stale opinion about a host that no longer exists.
    await redis.set(STATE_KEY, JSON.stringify(state), "EX", 24 * 60 * 60);
  } catch {
    /* alerting degrades to "one duplicate per restart", which is the right failure */
  }
}

/** SET NX with a TTL — the same primitive the feed uses to dedupe views. Returns false when this
 * subject has already alerted inside the cooldown. */
async function claimCooldown(key: string): Promise<boolean> {
  try {
    const set = await redis.set(`ops:cooldown:${key}`, "1", "EX", COOLDOWN_SEC, "NX");
    return set === "OK";
  } catch {
    // Redis down. Alerting anyway is the right call: the failure mode is a duplicate notification,
    // and the alternative is silence during exactly the kind of incident this exists for.
    return true;
  }
}
