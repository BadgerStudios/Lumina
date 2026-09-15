import type { FastifyInstance } from "fastify";
import { z } from "zod";

const deviceSchema = z.object({
  /** FCM registration token from the device. */
  token: z.string().min(10).max(4096),
  platform: z.literal("android").optional(),
});
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import { requireAuth } from "../../plugins/authenticate.js";
import { sendPushToUser } from "../../lib/push.js";
import { isSoundId } from "@lumina/shared";

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

export default async function pushRoutes(fastify: FastifyInstance) {
  // Public: the VAPID public key isn't secret (it's sent to every browser as
  // applicationServerKey when subscribing) — no auth needed to fetch it.
  fastify.get("/vapid-public-key", async () => ({ publicKey: env.VAPID_PUBLIC_KEY ?? null }));

  fastify.post("/subscribe", { schema: { body: subscribeSchema }, preHandler: [requireAuth] }, async (request, reply) => {
    const body = request.body as z.infer<typeof subscribeSchema>;
    await prisma.pushSubscription.upsert({
      where: { endpoint: body.endpoint },
      create: {
        userId: request.userId!,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
      },
      // A subscription can legitimately move to a different account on a shared device
      // (log out, log back in as someone else, same browser/service-worker registration).
      update: { userId: request.userId!, p256dh: body.keys.p256dh, auth: body.keys.auth },
    });
    reply.code(204).send();
  });

  fastify.post("/unsubscribe", { schema: { body: unsubscribeSchema }, preHandler: [requireAuth] }, async (request, reply) => {
    const body = request.body as z.infer<typeof unsubscribeSchema>;
    await prisma.pushSubscription.deleteMany({ where: { endpoint: body.endpoint, userId: request.userId! } });
    reply.code(204).send();
  });

  /**
   * Register this device for native notifications.
   *
   * Upserted on the token rather than created, and the token is unique platform-wide: the same
   * device re-registering must move it to whoever is signed in now, not accumulate a second row
   * that would send someone else's notifications to this phone.
   *
   * Deliberately separate from the web-push subscription above. A phone normally holds both — the
   * native one so Android can play the app's own sound, the web one so nothing changes for every
   * other client — and registering one must not disturb the other.
   */
  fastify.post("/device", { schema: { body: deviceSchema }, preHandler: [requireAuth] }, async (request) => {
    const body = request.body as z.infer<typeof deviceSchema>;
    // Returns the tones so the phone can reconcile its channels on every registration. A reinstall
    // wipes the channels but not this row, and without this the server would keep naming a channel
    // the phone no longer has — which Android drops without a sound or an error.
    const row = await prisma.deviceToken.upsert({
      where: { token: body.token },
      create: { token: body.token, userId: request.userId!, platform: body.platform ?? "android" },
      update: { userId: request.userId!, lastSeenAt: new Date() },
      select: { messageSound: true, directSound: true, mentionSound: true, channelSound: true },
    });
    return { ok: true, ...row };
  });

  const soundsSchema = z.object({
    token: z.string().min(10).max(4096),
    messageSound: z.string().refine(isSoundId, "Unknown tone"),
    directSound: z.string().refine(isSoundId, "Unknown tone"),
    mentionSound: z.string().refine(isSoundId, "Unknown tone"),
    channelSound: z.string().refine(isSoundId, "Unknown tone"),
  });

  /**
   * Choose this phone's tones. Scoped to the caller's own token, so nobody can set someone else's;
   * validated against the shared table, so a value here is always a resource the app actually has.
   * The phone creates the matching channels itself after this succeeds — server first, so a failed
   * native step is retried at the next registration rather than leaving the two out of step.
   */
  fastify.post("/device/sounds", { schema: { body: soundsSchema }, preHandler: [requireAuth] }, async (request) => {
    const body = request.body as z.infer<typeof soundsSchema>;
    const { count } = await prisma.deviceToken.updateMany({
      where: { token: body.token, userId: request.userId! },
      data: { messageSound: body.messageSound, directSound: body.directSound, mentionSound: body.mentionSound, channelSound: body.channelSound },
    });
    return { ok: count === 1, messageSound: body.messageSound, directSound: body.directSound, mentionSound: body.mentionSound, channelSound: body.channelSound };
  });

  /** Sign-out, or notifications turned off on this device. */
  fastify.delete("/device", { schema: { body: deviceSchema }, preHandler: [requireAuth] }, async (request) => {
    const body = request.body as z.infer<typeof deviceSchema>;
    // Scoped to the caller: a token is only ever removable by the account currently holding it.
    await prisma.deviceToken.deleteMany({ where: { token: body.token, userId: request.userId! } });
    return { ok: true };
  });

  /** Its own tag so a repeated test replaces the last one instead of stacking up. */
  const TEST_TAG = "lumina-test-notification";

  /**
   * Send yourself a notification, to prove the path works.
   *
   * Everything up to the device can be checked from the server — the credential signs, FCM accepts
   * the call, the channel ids match the ones the app creates. What none of that shows is whether a
   * phone in someone's pocket actually lights up, and that is the only part that matters. This is
   * the one step that can't be inferred, so it is worth a button.
   *
   * Only ever to the caller's own devices: no id is accepted, so this can't be pointed at anyone
   * else. Rate-limited because each call fans out to real push services.
   *
   * The counts are taken either side of the send because sendPushToUser prunes registrations that
   * come back dead. Reporting what survived is more honest than reporting what was attempted: a
   * phone that has been wiped or had the app removed leaves a token behind that will never ring
   * again, and saying "sent to 2 devices" when one of them stopped existing is how someone ends up
   * debugging a phone that was never going to receive anything.
   */
  fastify.post(
    "/test",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } }, preHandler: [requireAuth] },
    async (request) => {
      const userId = request.userId!;
      const count = async () =>
        Promise.all([
          prisma.pushSubscription.count({ where: { userId } }),
          prisma.deviceToken.count({ where: { userId } }),
        ]);

      const [webBefore, nativeBefore] = await count();
      const targeted = webBefore + nativeBefore;
      if (targeted === 0) return { targeted: 0, delivered: 0 };

      await sendPushToUser(userId, {
        title: "Lumina",
        body: "Notifications are working on this device.",
        url: "/",
        tag: TEST_TAG,
      });

      const [webAfter, nativeAfter] = await count();
      return { targeted, delivered: webAfter + nativeAfter };
    },
  );
}
