import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { currentPqKeys, establishSession } from "./service.js";

/**
 * Handshake surface for the post-quantum transport. Deliberately UNAUTHENTICATED: the login
 * request itself is exactly the traffic most worth sealing, so the shield must be available
 * before any token exists. Nothing here is secret — public keys and a random session id.
 */
export default async function pqRoutes(fastify: FastifyInstance) {
  fastify.get("/keys", async () => ({
    alg: "x25519+mlkem768/hkdf-sha256/xchacha20poly1305",
    ...(await currentPqKeys()),
  }));

  fastify.post(
    "/session",
    {
      schema: {
        body: z.object({
          kid: z.string().min(1).max(32),
          clientX25519Pub: z.string().min(1).max(64),
          mlkemCiphertext: z.string().min(1).max(2048),
        }),
      },
      config: {
        // Handshakes do real KEM math; keep a lid on drive-by hammering.
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async (request) => establishSession(request.body as { kid: string; clientX25519Pub: string; mlkemCiphertext: string }),
  );
}
