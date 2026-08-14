import type { FastifyInstance, FastifyRequest } from "fastify";
import { sessionKeys, seal, unseal } from "./service.js";

declare module "fastify" {
  interface FastifyRequest {
    pqKeys?: { c2s: Buffer; s2c: Buffer } | null;
  }
}

export const PQ_CONTENT_TYPE = "application/x-lumina-pq";
export const PQ_SESSION_HEADER = "x-pq-session";

/**
 * The transparent transport layer: any request carrying x-pq-session gets its body unsealed on
 * the way in and its JSON response sealed on the way out. Requests WITHOUT the header flow
 * exactly as before — the shield is strictly opt-in per request, so every existing client, bot,
 * webhook and suite keeps working unchanged.
 *
 * A missing/expired session answers 428 (Precondition Required) with a machine-readable code,
 * and clients re-handshake — that failure IS the traffic-key rotation working.
 */
export function registerPqTransport(fastify: FastifyInstance): void {
  fastify.addHook("onRequest", async (request, reply) => {
    const sessionId = request.headers[PQ_SESSION_HEADER];
    if (typeof sessionId !== "string" || !sessionId) return;
    const keys = await sessionKeys(sessionId);
    if (!keys) {
      await reply.code(428).send({ error: "PQ session expired — re-handshake at /api/pq/session", code: "PQ_SESSION_EXPIRED" });
      return reply;
    }
    request.pqKeys = keys;
  });

  fastify.addContentTypeParser(PQ_CONTENT_TYPE, { parseAs: "buffer" }, (request: FastifyRequest, body: Buffer, done) => {
    try {
      if (!request.pqKeys) {
        done(Object.assign(new Error("Sealed body without a valid PQ session"), { statusCode: 428 }));
        return;
      }
      const plain = unseal(request.pqKeys.c2s, body);
      done(null, plain.length ? JSON.parse(plain.toString("utf8")) : {});
    } catch (err) {
      done(err as Error);
    }
  });

  fastify.addHook("onSend", async (request, reply, payload) => {
    if (!request.pqKeys) return payload;
    const contentType = String(reply.getHeader("content-type") ?? "");
    // Only JSON is sealed: media streams/downloads keep their own framing (they are public
    // assets served by URL capability; sealing them would break range requests for no gain).
    if (!contentType.includes("application/json")) return payload;
    if (payload === undefined || payload === null) return payload;
    const plain = typeof payload === "string" ? Buffer.from(payload) : Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    const sealed = seal(request.pqKeys.s2c, plain);
    reply.header("content-type", PQ_CONTENT_TYPE);
    reply.header("x-pq", "1");
    return sealed;
  });
}
