import type { OAuthAuthorizeInfoDTO, UserDTO } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { generateRefreshToken, hashRefreshToken } from "../../lib/jwt.js";
import { serializeUser } from "../../lib/serialize.js";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../../lib/errors.js";

const CODE_TTL_SECONDS = 5 * 60; // standard OAuth2 authorization-code lifetime
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// v1 deliberately supports exactly one scope — "identify" (read the consenting user's public
// profile via GET /api/oauth2/identify). Not a general scope system layered on the existing
// role/permission bitfield; a real expansion (an app acting on a user's behalf beyond reading
// their profile) is a bigger trust-boundary decision than this pass takes on — see roadmap.
export const SUPPORTED_SCOPE = "identify";

async function requireApplication(clientId: string) {
  const app = await prisma.application.findUnique({ where: { id: clientId } });
  if (!app) throw new NotFoundError("Unknown client_id");
  return app;
}

function requireRegisteredRedirect(app: { redirectUris: string[] }, redirectUri: string): void {
  // Exact string match only — no prefix/wildcard matching. Standard OAuth2 hardening against
  // code/token redirection to an attacker-controlled URI that merely starts with a registered one.
  if (!app.redirectUris.includes(redirectUri)) {
    throw new BadRequestError("redirect_uri is not registered for this application");
  }
}

function requireSupportedScope(scope: string): void {
  if (scope !== SUPPORTED_SCOPE) {
    throw new BadRequestError(`Unsupported scope — only "${SUPPORTED_SCOPE}" is available`);
  }
}

/** Backs the consent screen (GET /api/oauth2/authorize) — public-safe app info only, and
 * validates client_id/redirect_uri/scope BEFORE the frontend ever renders an "Approve" button,
 * so a malformed/malicious authorize link fails loudly instead of silently minting a code for
 * an unregistered redirect. */
export async function getAuthorizeInfo(params: { clientId: string; redirectUri: string; scope: string }): Promise<OAuthAuthorizeInfoDTO> {
  const app = await requireApplication(params.clientId);
  requireRegisteredRedirect(app, params.redirectUri);
  requireSupportedScope(params.scope);
  return { clientId: app.id, name: app.name, iconUrl: app.iconUrl, scope: params.scope, redirectUri: params.redirectUri };
}

/** The user clicked "Approve" — mints a short-lived, single-use code and returns the full
 * redirect URL (with `code`/`state` query params) for the frontend to navigate to. Re-validates
 * everything getAuthorizeInfo already checked rather than trusting the frontend round-trip. */
export async function approveAuthorization(params: {
  userId: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state?: string;
}): Promise<string> {
  const app = await requireApplication(params.clientId);
  requireRegisteredRedirect(app, params.redirectUri);
  requireSupportedScope(params.scope);

  const code = generateRefreshToken();
  const codeHash = hashRefreshToken(code);
  await prisma.oAuthAuthorizationCode.create({
    data: {
      codeHash,
      applicationId: app.id,
      userId: params.userId,
      redirectUri: params.redirectUri,
      scope: params.scope,
      expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000),
    },
  });

  const redirectUrl = new URL(params.redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (params.state) redirectUrl.searchParams.set("state", params.state);
  return redirectUrl.toString();
}

/** Server-to-server token exchange — authenticated by client_id + client_secret (never a user
 * session), matching every standard OAuth2 authorization-code implementation. */
export async function exchangeCodeForToken(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ accessToken: string; tokenType: "Bearer"; scope: string; expiresIn: number }> {
  const app = await requireApplication(params.clientId);
  if (!app.clientSecretHash || hashRefreshToken(params.clientSecret) !== app.clientSecretHash) {
    throw new UnauthorizedError("Invalid client credentials");
  }

  const codeHash = hashRefreshToken(params.code);
  const row = await prisma.oAuthAuthorizationCode.findUnique({ where: { codeHash } });
  if (!row || row.applicationId !== app.id) throw new UnauthorizedError("Invalid authorization code");
  if (row.usedAt) throw new UnauthorizedError("Authorization code already used");
  if (row.expiresAt.getTime() < Date.now()) throw new UnauthorizedError("Authorization code expired");
  if (row.redirectUri !== params.redirectUri) throw new UnauthorizedError("redirect_uri mismatch");

  const accessToken = generateRefreshToken();
  const tokenHash = hashRefreshToken(accessToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);

  await prisma.$transaction([
    prisma.oAuthAuthorizationCode.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    prisma.oAuthAccessToken.create({
      data: { tokenHash, applicationId: app.id, userId: row.userId, scope: row.scope, expiresAt },
    }),
  ]);

  return { accessToken, tokenType: "Bearer", scope: row.scope, expiresIn: TOKEN_TTL_SECONDS };
}

/** GET /api/oauth2/identify's implementation — the ONLY thing an OAuth access token can ever
 * be used for in v1 (see SUPPORTED_SCOPE above). Deliberately not wired into the general
 * requireAuth preHandler every other route uses, so an OAuth token literally cannot reach any
 * endpoint beyond this one no matter what a buggy/malicious third party sends it to. */
export async function identifyFromToken(token: string): Promise<UserDTO> {
  const tokenHash = hashRefreshToken(token);
  const row = await prisma.oAuthAccessToken.findUnique({ where: { tokenHash }, include: { user: true } });
  if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now()) {
    throw new UnauthorizedError("Invalid or expired OAuth token");
  }
  return serializeUser(row.user);
}
