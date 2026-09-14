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
    await prisma.deviceToken.upsert({
      where: { token: body.token },
      create: { token: body.token, userId: request.userId!, platform: body.platform ?? "android" },
      update: { userId: request.userId!, lastSeenAt: new Date() },
    });
    return { ok: true };
  });

  /** Sign-out, or notifications turned off on this device. */
  fastify.delete("/device", { schema: { body: deviceSchema }, preHandler: [requireAuth] }, async (request) => {
    const body = request.body as z.infer<typeof deviceSchema>;
    // Scoped to the caller: a token is only ever removable by the account currently holding it.
    await prisma.deviceToken.deleteMany({ where: { token: body.token, userId: request.userId! } });
    return { ok: true };
  });
}
