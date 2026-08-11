import webpush from "web-push";
import { prisma } from "../db/prisma.js";
import { env } from "../config/env.js";

const enabled = !!env.VAPID_PUBLIC_KEY && !!env.VAPID_PRIVATE_KEY;

if (enabled) {
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
}

export interface PushPayload {
  title: string;
  body: string;
  // Deep-link the notification click should land on — see public/sw.js's notificationclick.
  url: string;
  /** Collapses repeats into one notification per conversation/subject rather than one per event.
   * On a watch this is the difference between a buzz per message and forty. */
  tag?: string;
  /** A stronger vibration pattern on wearables. Reserved for things a person would want to feel
   * through a sleeve — a direct mention, not a general channel message. */
  urgent?: boolean;
}

/**
 * Fans a push notification out to every device the user has subscribed on. Best-effort: a
 * dead subscription (410 Gone / 404, e.g. the user uninstalled/cleared the browser) is pruned
 * so the table doesn't accumulate garbage, but one dead subscription never blocks delivery to
 * the user's other devices.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!enabled) return;
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subs.length === 0) return;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        }
      }
    }),
  );
}
