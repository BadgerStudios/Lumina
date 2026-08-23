import { timingSafeEqual } from "node:crypto";
import type { OAuthAuthorizeInfoDTO, OAuthBotTargetServerDTO, UserDTO } from "@lumina/shared";
import { Permissions } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { generateRefreshToken, hashRefreshToken } from "../../lib/jwt.js";
import { serializeUser } from "../../lib/serialize.js";
import { computeEffectivePermissions } from "../../permissions/permissionService.js";
import { recordAuditLog } from "../../lib/auditLog.js";
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from "../../lib/errors.js";

const CODE_TTL_SECONDS = 5 * 60; // standard OAuth2 authorization-code lifetime
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// v1 deliberately supports exactly one scope — "identify" (read the consenting user's public
// profile via GET /api/oauth2/identify). Not a general scope system layered on the existing
// role/permission bitfield; a real expansion (an app acting on a user's behalf beyond reading
// their profile) is a bigger trust-boundary decision than this pass takes on — see roadmap.
export const SUPPORTED_SCOPE = "identify";

/**
 * The bot-install scope, deliberately shaped like Discord's so existing habits and documentation
 * transfer: /oauth2/authorize?client_id=...&scope=bot&permissions=<bits>[&guild_id=...].
 *
 * It is NOT an authorization-code grant. Nothing is minted and there is no redirect leg — the
 * approval IS the effect: the application's bot user becomes a member of the chosen server. The
 * point of routing it through consent rather than leaving it to the invite-redeem path is that
 * a bot must be admitted BY someone who administers the server, not by anyone who happens to
 * hold an invite code.
 */
export const BOT_SCOPE = "bot";

/** Permissions a bot may never be handed through an install link, whatever the URL asks for.
 * ADMINISTRATOR bypasses every other check (see hasPermission), so granting it from a link an
 * app author wrote is the one grant that cannot be reasoned about afterwards. */
const BOT_FORBIDDEN_PERMISSIONS = Permissions.ADMINISTRATOR;

/** Every defined permission except the forbidden ones. Used as the grantable set for owners and
 * administrators. Deliberately an explicit positive mask rather than `~BOT_FORBIDDEN_PERMISSIONS`:
 * the complement of a bigint is negative (~32768n === -32769n), which is arithmetically fine but
 * ships a negative "bitfield" to the client and reads like a bug in every log and API response. */
const BOT_INSTALLABLE_PERMISSIONS = Object.values(Permissions).reduce((acc, bit) => acc | bit, 0n) & ~BOT_FORBIDDEN_PERMISSIONS;

export function parsePermissionBits(raw: string | undefined): bigint {
  if (!raw) return 0n;
  if (!/^\d{1,30}$/.test(raw)) throw new BadRequestError("permissions must be a decimal bitfield");
  return BigInt(raw) & ~BOT_FORBIDDEN_PERMISSIONS;
}

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
  if (scope !== SUPPORTED_SCOPE && scope !== BOT_SCOPE) {
    throw new BadRequestError(`Unsupported scope — only "${SUPPORTED_SCOPE}" and "${BOT_SCOPE}" are available`);
  }
}

/** Servers this user may install a bot into: the ones they own or hold MANAGE_SERVER on. The
 * grantable set travels with each row so the consent screen can show, per server, exactly which
 * of the requested permissions will actually be handed over. */
async function botTargetServers(userId: string, botUserId: string): Promise<OAuthBotTargetServerDTO[]> {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    select: { server: { select: { id: true, name: true, iconUrl: true, ownerId: true } } },
  });

  const botMemberships = await prisma.membership.findMany({
    where: { userId: botUserId, serverId: { in: memberships.map((m) => m.server.id) } },
    select: { serverId: true },
  });
  const botIn = new Set(botMemberships.map((m) => m.serverId));

  const out: OAuthBotTargetServerDTO[] = [];
  for (const { server } of memberships) {
    const owner = server.ownerId === userId;
    const effective = owner ? null : await computeEffectivePermissions(userId, server.id);
    const admin = effective !== null && (effective & Permissions.ADMINISTRATOR) !== 0n;
    const manages = owner || admin || (effective !== null && (effective & Permissions.MANAGE_SERVER) !== 0n);
    if (!manages) continue;
    // An owner or administrator can grant anything the link asks for; anyone else is capped at
    // what they themselves hold.
    const grantable = owner || admin ? BOT_INSTALLABLE_PERMISSIONS : effective!;
    out.push({
      id: server.id,
      name: server.name,
      iconUrl: server.iconUrl,
      alreadyPresent: botIn.has(server.id),
      grantablePermissions: (grantable & ~BOT_FORBIDDEN_PERMISSIONS).toString(),
    });
  }
  return out;
}

/** Backs the consent screen (GET /api/oauth2/authorize) — public-safe app info only, and
 * validates client_id/redirect_uri/scope BEFORE the frontend ever renders an "Approve" button,
 * so a malformed/malicious authorize link fails loudly instead of silently minting a code for
 * an unregistered redirect. */
export async function getAuthorizeInfo(params: {
  clientId: string;
  redirectUri?: string;
  scope: string;
  permissions?: string;
  userId: string;
}): Promise<OAuthAuthorizeInfoDTO> {
  const app = await requireApplication(params.clientId);
  requireSupportedScope(params.scope);

  if (params.scope === BOT_SCOPE) {
    // No redirect leg to validate: approving installs the bot, full stop. A bot link for an
    // application that never had a bot user is a dead link, so say so here rather than letting
    // the consent screen offer an Approve button that cannot work.
    const botUser = await prisma.user.findFirst({ where: { applicationId: app.id, isBot: true }, select: { id: true, username: true } });
    if (!botUser) throw new BadRequestError("This application has no bot user");
    return {
      clientId: app.id,
      name: app.name,
      iconUrl: app.iconUrl,
      scope: params.scope,
      redirectUri: null,
      bot: {
        botUserId: botUser.id,
        botUsername: botUser.username,
        requestedPermissions: parsePermissionBits(params.permissions).toString(),
        servers: await botTargetServers(params.userId, botUser.id),
      },
    };
  }

  if (!params.redirectUri) throw new BadRequestError("redirect_uri is required for this scope");
  requireRegisteredRedirect(app, params.redirectUri);
  return { clientId: app.id, name: app.name, iconUrl: app.iconUrl, scope: params.scope, redirectUri: params.redirectUri };
}

/**
 * The bot install itself. Re-derives every check rather than trusting the consent screen: the
 * frontend round-trip is a hint, not an authority.
 *
 * The granted permission set is `requested & grantable`, so a moderator with MANAGE_SERVER cannot
 * install a bot with BAN_MEMBERS they do not hold themselves, and ADMINISTRATOR is stripped for
 * everyone — a bot that bypasses every subsequent check should never come from a link an app
 * author composed.
 */
export async function installBot(params: {
  userId: string;
  clientId: string;
  guildId: string;
  permissions?: string;
}): Promise<{ serverId: string; botUserId: string; grantedPermissions: string; alreadyPresent: boolean }> {
  const app = await requireApplication(params.clientId);
  const botUser = await prisma.user.findFirst({ where: { applicationId: app.id, isBot: true }, select: { id: true } });
  if (!botUser) throw new BadRequestError("This application has no bot user");

  const server = await prisma.server.findUnique({ where: { id: params.guildId }, select: { id: true, ownerId: true } });
  if (!server) throw new NotFoundError("Server not found");

  const owner = server.ownerId === params.userId;
  const effective = owner ? 0n : await computeEffectivePermissions(params.userId, server.id);
  const admin = (effective & Permissions.ADMINISTRATOR) !== 0n;
  if (!owner && !admin && (effective & Permissions.MANAGE_SERVER) === 0n) {
    throw new ForbiddenError("You need Manage Server on that server to add a bot");
  }

  const grantable = owner || admin ? BOT_INSTALLABLE_PERMISSIONS : effective;
  const granted = parsePermissionBits(params.permissions) & grantable & ~BOT_FORBIDDEN_PERMISSIONS;

  const existing = await prisma.membership.findUnique({
    where: { userId_serverId: { userId: botUser.id, serverId: server.id } },
    select: { id: true },
  });

  await prisma.$transaction(async (tx) => {
    const membership =
      existing ??
      (await tx.membership.create({ data: { userId: botUser.id, serverId: server.id }, select: { id: true } }));

    // A managed role named after the app, Discord-style: the grant is visible in role settings
    // and revocable there, instead of being an invisible property of the membership.
    if (granted !== 0n) {
      const top = await tx.role.findFirst({ where: { serverId: server.id }, orderBy: { position: "desc" }, select: { position: true } });
      const role =
        (await tx.role.findFirst({ where: { serverId: server.id, name: app.name }, select: { id: true } })) ??
        (await tx.role.create({
          data: {
            serverId: server.id,
            name: app.name,
            permissions: granted,
            position: (top?.position ?? 0) + 1,
            mentionable: false,
          },
          select: { id: true },
        }));
      await tx.role.update({ where: { id: role.id }, data: { permissions: granted } });
      await tx.roleAssignment.upsert({
        where: { membershipId_roleId: { membershipId: membership.id, roleId: role.id } },
        create: { membershipId: membership.id, roleId: role.id },
        update: {},
      });
    }
  });

  if (!existing) {
    await recordAuditLog({
      serverId: server.id,
      actorId: params.userId,
      actionType: "bot.add",
      targetId: botUser.id,
      targetType: "member",
    });
  }

  return { serverId: server.id, botUserId: botUser.id, grantedPermissions: granted.toString(), alreadyPresent: !!existing };
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
  // Belt and braces: the route already forks on BOT_SCOPE, but an authorization code is
  // meaningless for an install and must never be mintable through this path.
  if (params.scope === BOT_SCOPE) throw new BadRequestError("The bot scope is installed, not exchanged for a code");

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
  // Constant-time compare of the hashed client secret — matches the timingSafeEqual convention
  // used for the equivalent webhook-token and email-verification checks elsewhere.
  const presentedSecret = app.clientSecretHash ? Buffer.from(hashRefreshToken(params.clientSecret)) : null;
  const expectedSecret = app.clientSecretHash ? Buffer.from(app.clientSecretHash) : null;
  if (
    !presentedSecret ||
    !expectedSecret ||
    presentedSecret.length !== expectedSecret.length ||
    !timingSafeEqual(presentedSecret, expectedSecret)
  ) {
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

  // Claim the code with a conditional update so two concurrent /token calls can't both pass the
  // usedAt read above and each mint a token — the loser updates zero rows and is rejected.
  const claim = await prisma.oAuthAuthorizationCode.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claim.count === 0) throw new UnauthorizedError("Authorization code already used");

  await prisma.oAuthAccessToken.create({
    data: { tokenHash, applicationId: app.id, userId: row.userId, scope: row.scope, expiresAt },
  });

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
