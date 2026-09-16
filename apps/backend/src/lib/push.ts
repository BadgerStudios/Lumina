import { resolvePreferences } from "../modules/users/preferences.js";
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
  /** How long a store-and-forward relay may hold it for a phone that is off. A ring is worthless
   * after a minute; a message is still worth reading tomorrow (the default, one day). */
  ttlSeconds?: number;
  /** Send even when the person is active on a desktop — for the few things that must never be
   * quietly absorbed by an open tab, like an infrastructure alert to the owner. */
  force?: boolean;
}

/**
 * Fans a push notification out to every device the user has subscribed on. Best-effort: a
 * dead subscription (410 Gone / 404, e.g. the user uninstalled/cleared the browser) is pruned
 * so the table doesn't accumulate garbage, but one dead subscription never blocks delivery to
 * the user's other devices.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  // The person's own switch for this kind (User Settings → Notifications) wins over everything
  // that decided to send: a kind turned off stays silent on every device.
  const prefUser = await prisma.user.findUnique({ where: { id: userId }, select: { preferencesJson: true } });
  if (!resolvePreferences(prefUser?.preferencesJson).notifications.push[payload.kind ?? "message"]) return;
  const kind = payload.kind ?? "message";
  // Someone typing away on a desktop sees the message where they are; buzzing their phone as well is
  // the "iffy" everyone notices. (Dynamic import: realtime/io imports the handlers that import this file.)
  if (!payload.force) {
    const { userIsActive } = await import("../realtime/io.js");
    if (await userIsActive(userId)) {
      // eslint-disable-next-line no-console
      console.log(`[push] ${kind} -> ${userId}: skipped, active on a desktop`);
      return;
    }
  }
  // Both transports, independently. A phone usually holds an FCM token AND a web-push
  // subscription; the native one is what can play the app's own sound, and web push is what still
  // reaches every desktop and browser. Failing at one must never stop the other.
  const [web, native] = await Promise.all([sendWebPush(userId, payload), sendNativePush(userId, payload)]);
  if (web.total + native.total > 0) {
    // One line per push so "did it go out, and to what?" is answerable from the log alone.
    // eslint-disable-next-line no-console
    console.log(`[push] ${kind} -> ${userId}: native ${native.sent}/${native.total}, web ${web.sent}/${web.total}${payload.tag ? ` (${payload.tag})` : ""}`);
  }
}

interface Delivery {
  sent: number;
  total: number;
}

/**
 * The native half: notifications Android renders itself, on a channel carrying the app's sound.
 *
 * Tokens that come back dead are deleted rather than retried forever — an uninstalled app leaves
 * its token behind, and without pruning every later notification pays for it.
 */
async function sendNativePush(userId: string, payload: PushPayload): Promise<Delivery> {
  if (!isFcmConfigured()) return { sent: 0, total: 0 };
  const tokens = await prisma.deviceToken.findMany({
    where: { userId },
    select: { id: true, token: true, messageSound: true, directSound: true, mentionSound: true, channelSound: true },
  });
  if (tokens.length === 0) return { sent: 0, total: 0 };

  const results = await Promise.all(
    tokens.map(async (row) => {
      const alive = await sendFcmToToken(
        row.token,
        { title: payload.title, body: payload.body, url: payload.url, tag: payload.tag, kind: payload.kind, ttlSeconds: payload.ttlSeconds },
        tonesFrom(row),
      );
      if (!alive) await prisma.deviceToken.delete({ where: { id: row.id } }).catch(() => {});
      return alive;
    }),
  );
  return { sent: results.filter(Boolean).length, total: tokens.length };
}

async function sendWebPush(userId: string, payload: PushPayload): Promise<Delivery> {
  if (!enabled) return { sent: 0, total: 0 };
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subs.length === 0) return { sent: 0, total: 0 };

  let sent = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          { TTL: payload.ttlSeconds ?? 86_400 },
        );
        sent++;
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
  return { sent, total: subs.length };
}
