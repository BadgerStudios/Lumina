import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../plugins/authenticate.js";
import { UnauthorizedError } from "../../lib/errors.js";
import { approveAuthorization, exchangeCodeForToken, getAuthorizeInfo, identifyFromToken } from "./service.js";

const authorizeQuerySchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  scope: z.string().min(1),
  state: z.string().optional(),
});

const authorizeBodySchema = z.object({
  clientId: z.string().min(1),
  redirectUri: z.string().url(),
  scope: z.string().min(1),
  state: z.string().optional(),
});

const tokenBodySchema = z.object({
  grantType: z.literal("authorization_code"),
  code: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  redirectUri: z.string().url(),
});

/** Mounted under /api/oauth2 — delegated authorization for third-party apps (see
 * modules/oauth2/service.ts for the full design rationale). Standard authorization-code grant:
 * GET /authorize (consent-screen data) -> POST /authorize (user approves, mints a code) ->
 * POST /token (app exchanges code server-to-server) -> GET /identify (the only thing the
 * resulting token can do). */
export default async function oauth2Routes(fastify: FastifyInstance) {
  // requireAuth here (not on /token or /identify) because this is "which Lumina user is
  // consenting" — the frontend consent page needs a real logged-in session to know who's
  // approving, same as any Login-with-X provider's own authorize endpoint.
  fastify.get("/authorize", { schema: { querystring: authorizeQuerySchema }, preHandler: [requireAuth] }, async (request) => {
    const query = request.query as z.infer<typeof authorizeQuerySchema>;
    return getAuthorizeInfo({ clientId: query.client_id, redirectUri: query.redirect_uri, scope: query.scope });
  });

  fastify.post("/authorize", { schema: { body: authorizeBodySchema }, preHandler: [requireAuth] }, async (request) => {
    const body = request.body as z.infer<typeof authorizeBodySchema>;
    const redirectUrl = await approveAuthorization({
      userId: request.userId!,
      clientId: body.clientId,
      redirectUri: body.redirectUri,
      scope: body.scope,
      state: body.state,
    });
    return { redirectUrl };
  });

  // Deliberately NO requireAuth — this is the third-party app's own backend calling
  // server-to-server, authenticated by clientId+clientSecret in the body, not a Lumina session.
  fastify.post("/token", { schema: { body: tokenBodySchema } }, async (request) => {
    const body = request.body as z.infer<typeof tokenBodySchema>;
    return exchangeCodeForToken({
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      code: body.code,
      redirectUri: body.redirectUri,
    });
  });

  fastify.get("/identify", async (request) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new UnauthorizedError("Missing OAuth access token");
    return identifyFromToken(header.slice("Bearer ".length));
  });
}
