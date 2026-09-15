import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";
import { sendPushToUser } from "../../lib/push.js";
import { ROLE_LADDER, isStaff } from "../../lib/platformRole.js";

/**
 * Tell staff when something arrives in the queue.
 *
 * Every other notification in Lumina is addressed to one person about their own life — a mention,
 * a friend request, a reply. This one is about work, and it has the opposite failure mode: a report
 * nobody is told about simply sits there. The queue badge only helps someone who already opened the
 * console, and the whole point of a report is that it happens when staff are not looking.
 *
 * ## Why the body never says what was reported
 *
 * A notification lands on a lock screen, which is the least private surface a person owns, and
 * these are read in public by people who are not the subject of them. The reported text is written
 * by a stranger, the reported account has a name, and neither belongs on a bus window. So the body
 * says a report arrived and how many are waiting, and the queue itself says what it was. Anyone
 * acting on it has to open the app, which is where the authorisation check lives anyway.
 *
 * ## Two rules against becoming noise
 *
 * Borrowed wholesale from modules/ops/alerts.ts, because alerting dies the same way everywhere.
 *
 * 1. **A cooldown per kind.** Twenty reports on one video in a minute is one notification. The
 *    cooldown is per kind rather than global so a flood of video reports can't mute the support
 *    ticket that arrives during it — those are different people's problems.
 * 2. **One collapse tag for all of them.** Staff care about the queue, not about each arrival, so
 *    a second notification replaces the first rather than stacking beneath it. What the lock screen
 *    shows is the current state: what came in last, and how much is waiting.
 */

const COOLDOWN_SEC = 120;

/**
 * Derived from the ladder rather than listed, so adding a rank above MODERATOR cannot quietly
 * create a staff role that never hears about the queue it is responsible for.
 */
export const STAFF_ROLES = ROLE_LADDER.filter(isStaff);

export type QueueKind = "report" | "support" | "system" | "video";

/** One fixed line per kind. Nothing here is derived from what a reporter typed. */
const HEADLINE: Record<QueueKind, string> = {
  report: "A user or message was reported",
  support: "Someone opened a support ticket",
  system: "The platform flagged something itself",
  video: "A video was reported",
};

/**
 * The line a staff member reads on a lock screen.
 *
 * Exported so the thing that must stay true can be asserted: it is built only from the kind and a
 * count, never from anything a reporter typed or anyone's name.
 */
export function queueBody(kind: QueueKind, waiting: number): string {
  return waiting > 1 ? `${HEADLINE[kind]}. ${waiting} items are waiting.` : `${HEADLINE[kind]}.`;
}

async function claimCooldown(kind: QueueKind): Promise<boolean> {
  try {
    const set = await redis.set(`staff:queue:cooldown:${kind}`, "1", "EX", COOLDOWN_SEC, "NX");
    return set === "OK";
  } catch {
    // Redis down. Notifying anyway is the right call, the same as it is for ops alerts: the cost is
    // a duplicate notification, and the alternative is silence about moderation work.
    return true;
  }
}

/** Everything still waiting, across both tables — the number staff would see on the badge. */
async function openCount(): Promise<number> {
  const [content, videos] = await Promise.all([
    prisma.contentReport.count({ where: { status: "OPEN" } }),
    prisma.videoReport.count({ where: { status: "OPEN" } }),
  ]);
  return content + videos;
}

/**
 * Fire-and-forget by design: call it with `void`. A notification that fails must never take down
 * the report that triggered it — the report being filed is the part that matters, and a person who
 * clicked "report" should not see an error because a push service was slow.
 *
 * `excludeUserId` is the person who caused the item. Staff report things too, and being buzzed
 * about your own report is how someone turns these off.
 */
export async function notifyStaffOfQueueItem(params: {
  kind: QueueKind;
  excludeUserId?: string | null;
}): Promise<void> {
  const { kind, excludeUserId } = params;
  try {
    if (!(await claimCooldown(kind))) return;

    const staff = await prisma.user.findMany({
      where: { platformRole: { in: STAFF_ROLES } },
      select: { id: true },
    });
    if (staff.length === 0) return;

    const body = queueBody(kind, await openCount());

    await Promise.all(
      staff
        .filter((member) => member.id !== excludeUserId)
        .map((member) =>
          sendPushToUser(member.id, {
            title: "Lumina staff",
            body,
            url: "/staff/tickets",
            tag: "staff-queue",
          }),
        ),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[staff-notify] could not notify staff of a queue item:", (err as Error)?.message);
  }
}
