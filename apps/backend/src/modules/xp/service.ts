import { prisma } from "../../db/prisma.js";
import { levelForXp } from "../economy/split.js";
import { pushInboxNotification } from "../inbox/service.js";

/**
 * Server participation XP — native leveling, the feature Discord's communities ran Mee6 for
 * because Discord never built it.
 *
 * Design commitments, each deliberate:
 *
 *  - **Cooldown, not per-message**: one award per member per server per minute. Sixty messages in
 *    a minute earn the same as one, so spam is worthless and conversation is what levels you.
 *  - **Deterministic award**: 15-25 XP derived from the message id, not Math.random — replays and
 *    replicas agree, and nobody can farm re-rolls.
 *  - **No decay, no streaks**: a level ranks what someone did; it never punishes absence. That is
 *    the line between a game and a leash, and this platform hosts sixteen-year-olds.
 *  - **Rewards are real roles** through the existing role system — a level unlock IS a role grant,
 *    with everything roles already mean (colors, channel access via overwrites, hoisting).
 */

const COOLDOWN_MS = 60_000;

function awardFor(messageId: bigint): number {
  return 15 + Number(messageId % 11n); // 15..25, stable for a given message
}

/** Fire-and-forget from message creation — the send path never waits on XP. */
export async function awardMessageXp(userId: string, serverId: string, messageId: bigint): Promise<void> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - COOLDOWN_MS);

  // The cooldown is enforced IN the update predicate, so two racing messages cannot both award —
  // whichever one wins the row, the other's updateMany matches nothing.
  const bumped = await prisma.memberXp.updateMany({
    where: { userId, serverId, lastAwardAt: { lte: cutoff } },
    data: { xp: { increment: awardFor(messageId) }, lastAwardAt: now },
  });
  if (bumped.count === 0) {
    // Either on cooldown (fine, done) or the row doesn't exist yet.
    const exists = await prisma.memberXp.findUnique({ where: { userId_serverId: { userId, serverId } }, select: { userId: true } });
    if (exists) return;
    await prisma.memberXp
      .create({ data: { userId, serverId, xp: awardFor(messageId), lastAwardAt: now } })
      .catch(() => undefined); // raced another first-message create; that one awarded
  }

  const row = await prisma.memberXp.findUnique({ where: { userId_serverId: { userId, serverId } } });
  if (!row) return;
  const newLevel = levelForXp(row.xp);
  if (newLevel <= row.level) return;

  await prisma.memberXp.update({ where: { userId_serverId: { userId, serverId } }, data: { level: newLevel } });

  // Grant every reward at or below the new level that isn't held yet — "at or below" so a reward
  // configured after someone already passed that level still lands on their next level-up.
  const rewards = await prisma.levelReward.findMany({ where: { serverId, level: { lte: newLevel } } });
  if (rewards.length > 0) {
    const membership = await prisma.membership.findUnique({
      where: { userId_serverId: { userId, serverId } },
      select: { id: true, roles: { select: { roleId: true } } },
    });
    if (membership) {
      const held = new Set(membership.roles.map((r) => r.roleId));
      for (const reward of rewards) {
        if (held.has(reward.roleId)) continue;
        await prisma.roleAssignment
          .create({ data: { membershipId: membership.id, roleId: reward.roleId } })
          .catch(() => undefined); // role deleted or raced — nothing to force
      }
    }
  }

  await pushInboxNotification({
    userId,
    kind: "LEVEL_UP",
    bundleKey: `LEVEL_UP:${serverId}:${newLevel}`,
    serverId,
    preview: `You reached level ${newLevel}`,
  }).catch(() => undefined);
}

export async function leaderboard(serverId: string, viewerId: string) {
  const top = await prisma.memberXp.findMany({
    where: { serverId },
    include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true, isMinor: true, isOfficial: true } } },
    orderBy: { xp: "desc" },
    take: 20,
  });
  const me = await prisma.memberXp.findUnique({ where: { userId_serverId: { userId: viewerId, serverId } } });
  const rank = me ? (await prisma.memberXp.count({ where: { serverId, xp: { gt: me.xp } } })) + 1 : null;
  return {
    top: top.map((r, i) => ({
      rank: i + 1,
      userId: r.userId,
      username: r.user.username,
      displayName: r.user.displayName,
      avatarUrl: r.user.avatarUrl,
      // Carried so the route can apply minor/adult visibility — a leaderboard is a member list
      // with numbers on it, and it must hide exactly what the member list hides.
      isMinor: r.user.isMinor,
      isOfficial: r.user.isOfficial,
      xp: r.xp,
      level: r.level,
    })),
    me: me ? { rank, xp: me.xp, level: me.level } : null,
  };
}
