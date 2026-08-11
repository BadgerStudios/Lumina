import { ServerEvents } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";
import { getIO } from "../../realtime/io.js";
import { serializeMessage } from "../../lib/serialize.js";
import type { AddonManifest, AddonAutomation } from "./manifest.js";

/**
 * Runs the automations of every addon installed in a server against one new message.
 *
 * ## How this is called
 *
 * Fire-and-forget, after the message is already created and broadcast. An addon must never be able
 * to make sending a message slower or make it fail — a badly-written automation is the author's
 * problem, not something every member of the server should feel.
 *
 * ## The three things that keep this safe
 *
 * 1. **No loops.** Bot and webhook messages never trigger anything. Since the only action that
 *    creates a message posts as a bot, an addon physically cannot trigger itself or another addon.
 *    This is a structural guarantee, not a depth counter.
 * 2. **No unbounded work.** Manifests are capped (see manifest.ts) and a server's automations are
 *    rate-limited as a whole, so a keyword that matches everything costs a fixed amount.
 * 3. **No borrowed authority.** Every action runs through the same permission checks a person
 *    would face. An addon installed by a moderator does not inherit that moderator's power.
 */

/** Per server, per minute, across all its addons. Generous for real use, decisive against an
 * automation that fires on every single message in a busy channel. */
const ACTION_BUDGET = 60;
const BUDGET_WINDOW_SEC = 60;

interface TriggerContext {
  messageId: bigint;
  channelId: string;
  channelName: string;
  serverId: string;
  authorId: string;
  authorIsBot: boolean;
  isWebhook: boolean;
  content: string;
}

export async function runMessageAutomations(ctx: TriggerContext): Promise<void> {
  // The loop guard. Deliberately first and deliberately unconditional.
  if (ctx.authorIsBot || ctx.isWebhook) return;

  const installs = await loadInstalls(ctx.serverId);
  if (installs.length === 0) return;

  for (const install of installs) {
    const { manifest, botUserId } = install;

    for (const automation of manifest.automations) {
      if (automation.on !== "message.create") continue;
      if (!matches(automation, ctx)) continue;

      for (const action of automation.then) {
        if (!(await claimBudget(ctx.serverId))) return;
        try {
          await perform(action, ctx, botUserId);
        } catch {
          // One failing action must not stop the rest, and must never surface to the person who
          // simply sent a message. An addon that misbehaves is silent, not disruptive.
        }
      }
    }
  }
}

function matches(automation: AddonAutomation, ctx: TriggerContext): boolean {
  const { when } = automation;
  const content = ctx.content.toLowerCase();

  if (when.inChannels && when.inChannels.length > 0) {
    if (!when.inChannels.some((n) => n.replace(/^#/, "").toLowerCase() === ctx.channelName.toLowerCase())) {
      return false;
    }
  }
  if (when.minLength !== undefined && ctx.content.length < when.minLength) return false;
  if (when.maxLength !== undefined && ctx.content.length > when.maxLength) return false;

  // `contains` and `startsWith` are OR within themselves and AND with each other, which is what
  // reads naturally: "any of these words, and it starts with one of these".
  if (when.contains && when.contains.length > 0) {
    if (!when.contains.some((k) => content.includes(k.toLowerCase()))) return false;
  }
  if (when.startsWith && when.startsWith.length > 0) {
    if (!when.startsWith.some((k) => content.startsWith(k.toLowerCase()))) return false;
  }

  // An automation whose `when` is entirely empty would fire on every message in the server. That
  // is almost always a mistake in the manifest rather than an intent, so it is treated as one.
  const hasAnyCondition =
    (when.contains?.length ?? 0) > 0 ||
    (when.startsWith?.length ?? 0) > 0 ||
    when.minLength !== undefined ||
    when.maxLength !== undefined;
  return hasAnyCondition;
}

async function perform(
  action: AddonManifest["automations"][number]["then"][number],
  ctx: TriggerContext,
  botUserId: string | null,
): Promise<void> {
  switch (action.type) {
    case "react": {
      const reactorId = botUserId ?? ctx.authorId;
      // Composite PK on (messageId, userId, emoji) makes this idempotent, so a repeated trigger
      // can't stack duplicate reactions.
      await prisma.reaction.upsert({
        where: { messageId_userId_emoji: { messageId: ctx.messageId, userId: reactorId, emoji: action.emoji } },
        create: { messageId: ctx.messageId, userId: reactorId, emoji: action.emoji },
        update: {},
      });
      // Every action below broadcasts, for a reason worth stating: writing the row is only half of
      // doing the thing. Without the emit the database is correct and every open client still shows
      // the old state until someone reloads — which reads as "the addon didn't work". A test that
      // asserts against the database (as it should) passes straight through that.
      const count = await prisma.reaction.count({ where: { messageId: ctx.messageId, emoji: action.emoji } });
      emit(ctx, ServerEvents.REACTION_ADD, {
        messageId: ctx.messageId.toString(),
        emoji: action.emoji,
        userId: reactorId,
        count,
      });
      return;
    }

    case "pin": {
      const updated = await prisma.message.update({
        where: { id: ctx.messageId },
        data: { pinned: true },
        include: { author: true, attachments: true, reactions: true },
      });
      emit(ctx, ServerEvents.MESSAGE_UPDATE, serializeMessage(updated, null));
      return;
    }

    case "delete":
      await prisma.message.update({
        where: { id: ctx.messageId },
        data: { deletedAt: new Date(), content: "" },
      });
      emit(ctx, ServerEvents.MESSAGE_DELETE, { id: ctx.messageId.toString() });
      return;

    case "reply": {
      // No bot, no voice. Enforced again here rather than trusted from publish time, because an
      // Application's bot can be deleted after the addon was published.
      if (!botUserId) return;
      const { createChannelMessage } = await import("../messages/service.js");
      await createChannelMessage({
        userId: botUserId,
        channelId: ctx.channelId,
        // The only substitution there is. Anything richer would be a templating language, and a
        // templating language is a program.
        content: action.text.replaceAll("{user}", `<@${ctx.authorId}>`),
      });
      return;
    }
  }
}

interface CachedInstall {
  manifest: AddonManifest;
  botUserId: string | null;
}

const INSTALLS_TTL_SEC = 300;
const installsKey = (serverId: string) => `addons:installs:v1:${serverId}`;

/**
 * The installed addons for one server, cached.
 *
 * This runs on **every message sent in every server**, so the naive version — a joined query with
 * three levels of include, per message, in servers that have no addons at all — quietly doubles the
 * database load of the busiest path in the product to answer "no" almost every time. Caching the
 * answer (including the empty one) makes having the feature installed cost nothing for anyone not
 * using it.
 *
 * Cache, not store: it is derived from two tables and rebuilt on a miss, so a lost Redis costs one
 * query per server. Invalidated explicitly on install/enable/uninstall so a change is immediate
 * rather than up to five minutes later.
 */
async function loadInstalls(serverId: string): Promise<CachedInstall[]> {
  try {
    const cached = await redis.get(installsKey(serverId));
    if (cached) return JSON.parse(cached) as CachedInstall[];
  } catch {
    /* fall through to the database */
  }

  const rows = await prisma.serverAddon.findMany({
    where: { serverId, enabled: true },
    include: { addon: { include: { application: { include: { botUser: { select: { id: true } } } } } } },
  });
  const installs: CachedInstall[] = rows.map((r) => ({
    manifest: r.addon.manifest as unknown as AddonManifest,
    botUserId: r.addon.application?.botUser?.id ?? null,
  }));

  try {
    await redis.set(installsKey(serverId), JSON.stringify(installs), "EX", INSTALLS_TTL_SEC);
  } catch {
    /* caching is an optimisation, not a requirement */
  }
  return installs;
}

/** Called whenever a server's addons change, so a toggle takes effect on the next message rather
 * than whenever the TTL happens to lapse. */
export async function invalidateServerAddons(serverId: string): Promise<void> {
  try {
    await redis.del(installsKey(serverId));
  } catch {
    /* the TTL will catch it */
  }
}

/** Addon actions only ever apply to channel messages (the trigger is channel-scoped), so the room
 * is always the channel's. getIO() throws before the socket server is initialised, which in
 * practice only happens in scripts — hence the guard rather than an assumption. */
function emit(ctx: TriggerContext, event: string, payload: unknown): void {
  try {
    getIO().to(`channel:${ctx.channelId}`).emit(event, payload);
  } catch {
    /* no socket server in this process */
  }
}

/**
 * One shared budget per server, not per addon.
 *
 * Per-addon would let a server install ten addons and get ten times the budget, which is exactly
 * backwards — the thing worth bounding is the load one server can create, however it is spread.
 */
async function claimBudget(serverId: string): Promise<boolean> {
  try {
    const key = `addon:budget:${serverId}:${Math.floor(Date.now() / (BUDGET_WINDOW_SEC * 1000))}`;
    const used = await redis.incr(key);
    if (used === 1) await redis.expire(key, BUDGET_WINDOW_SEC * 2);
    return used <= ACTION_BUDGET;
  } catch {
    // Redis unavailable. Refusing to act is the safe direction: skipping an auto-reaction costs
    // nothing, while an unbounded loop with no brake costs the whole instance.
    return false;
  }
}
