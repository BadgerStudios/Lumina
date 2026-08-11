import type { FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { env } from "../../config/env.js";
import { requireAuth } from "../../plugins/authenticate.js";

const CREDENTIAL_TTL_SECONDS = 24 * 60 * 60; // 24h — generous since a call could run long; cheap to mint a fresh one per join anyway

/**
 * coturn's "REST API" time-limited credential scheme: username is `${expiryUnixTimestamp}:
 * ${anything}`, credential is base64(HMAC-SHA1(secret, username)) — coturn itself knows this
 * convention when started with --use-auth-secret, so nothing needs to be persisted server-side
 * per credential (no DB row, no revocation list — it just naturally expires). Minted fresh per
 * voice:join rather than a single static client-side username/password baked into the bundle,
 * which would be both eternally valid and visible to anyone who opens devtools.
 */
function mintTurnCredential(userId: string): { username: string; credential: string; expiresAt: number } {
  const expiresAt = Math.floor(Date.now() / 1000) + CREDENTIAL_TTL_SECONDS;
  const username = `${expiresAt}:${userId}`;
  const credential = createHmac("sha1", env.TURN_SECRET!).update(username).digest("base64");
  return { username, credential, expiresAt };
}

/** Mounted under /api/voice */
export default async function voiceRoutes(fastify: FastifyInstance) {
  fastify.get("/turn-credentials", { preHandler: [requireAuth] }, async (request) => {
    // No TURN_SECRET configured — respond with STUN-only rather than 500ing every voice join.
    // Matches the pre-existing documented limitation (roadmap Phase 8): calls between two peers
    // behind symmetric NAT would fail, same as before this endpoint existed.
    if (!env.TURN_SECRET) {
      return { iceServers: [] };
    }

    const { username, credential, expiresAt } = mintTurnCredential(request.userId!);
    const turnUrl = `turn:${env.TURN_HOST}:${env.TURN_PORT}`;
    return {
      iceServers: [
        { urls: [`${turnUrl}?transport=udp`, `${turnUrl}?transport=tcp`], username, credential },
      ],
      expiresAt,
    };
  });
}
