import webpush from "web-push";
import { prisma } from "../db/prisma.js";
import { env } from "../config/env.js";
import { isFcmConfigured, sendFcmToToken } from "./fcm.js";
import { tonesFrom, type PushKind } from "@lumina/shared";

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
  /** Which tone this plays on Android — see PUSH_KINDS. Default "message". On the web the
   * service worker uses it for a stronger vibration on a DM or a direct mention. */
  kind?: PushKind;
}

/**
 * Fans a push notification out to every device the user has subscribed on. Best-effort: a
 * dead subscription (410 Gone / 404, e.g. the user uninstalled/cleared the browser) is pruned
 * so the table doesn't accumulate garbage, but one dead subscription never blocks delivery to
 * the user's other devices.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  // Both transports, independently. A phone usually holds an FCM token AND a web-push
  // subscription; the native one is what can play the app's own sound, and web push is what still
  // reaches every desktop and browser. Failing at one must never stop the other.
  await Promise.all([sendWebPush(userId, payload), sendNativePush(userId, payload)]);
}

/**
 * The native half: notifications Android renders itself, on a channel carrying the app's sound.
 *
 * Tokens that come back dead are deleted rather than retried forever — an uninstalled app leaves
 * its token behind, and without pruning every later notification pays for it.
 */
async function sendNativePush(userId: string, payload: PushPayload): Promise<void> {
  if (!isFcmConfigured()) return;
  const tokens = await prisma.deviceToken.findMany({
    where: { userId },
    select: { id: true, token: true, messageSound: true, directSound: true, mentionSound: true, channelSound: true },
  });
  if (tokens.length === 0) return;

  await Promise.all(
    tokens.map(async (row) => {
      const alive = await sendFcmToToken(
        row.token,
        { title: payload.title, body: payload.body, url: payload.url, tag: payload.tag, kind: payload.kind },
        tonesFrom(row),
      );
      if (!alive) await prisma.deviceToken.delete({ where: { id: row.id } }).catch(() => {});
    }),
  );
}

async function sendWebPush(userId: string, payload: PushPayload): Promise<void> {
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
        } else {
          // Everything else (network error, 5xx, an oversized payload) previously vanished with
          // zero trace — a systemic delivery problem (bad VAPID keys, a payload over the ~4KB
          // web-push limit) was undebuggable from logs alone. Still best-effort: logged, not
          // thrown, so one bad subscription still never blocks delivery to the rest.
          // eslint-disable-next-line no-console
          console.error(`[push] delivery failed for subscription ${sub.id}:`, statusCode ?? (err as Error)?.message ?? err);
        }
      }
    }),
  );
}
