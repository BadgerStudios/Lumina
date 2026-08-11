import type { FastifyInstance } from "fastify";
import { z } from "zod";
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
}
