import crypto from "node:crypto";
import type { ApplicationDTO, ApplicationWithClientSecretDTO, ApplicationWithTokenDTO } from "@lumina/shared";
import { prisma } from "../../db/prisma.js";
import { generateRefreshToken, hashRefreshToken } from "../../lib/jwt.js";
import { hashPassword } from "../../lib/password.js";
import { serializeApplication } from "../../lib/serialize.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../lib/errors.js";

/**
 * Bot accounts are just User rows (isBot: true, applicationId set) — see the comment on
 * User.applicationId in schema.prisma. Bot usernames are slugified from the app name so
 * @mentions (modules/messages/mentions.ts) work naturally; collisions get a numeric suffix.
 */
function slugifyUsername(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  return base || "bot";
}

async function uniqueBotUsername(name: string): Promise<string> {
  const base = slugifyUsername(name);
  let candidate = base;
  let suffix = 0;
  // eslint-disable-next-line no-await-in-loop -- sequential by necessity, collisions are rare
  while (await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } })) {
    suffix += 1;
    candidate = `${base}_${suffix}`;
  }
  return candidate;
}

export async function listMyApplications(ownerId: string): Promise<ApplicationDTO[]> {
  const apps = await prisma.application.findMany({
    where: { ownerId },
    include: { botUser: { select: { id: true, username: true } } },
    orderBy: { createdAt: "desc" },
  });
  return apps.filter((a) => a.botUser).map((a) => serializeApplication(a, a.botUser!.id, a.botUser!.username));
}

export async function createApplication(params: {
  ownerId: string;
  name: string;
  description?: string | null;
}): Promise<ApplicationWithTokenDTO> {
  const name = params.name.trim();
  const username = await uniqueBotUsername(name);
  const botToken = generateRefreshToken();
  const botTokenHash = hashRefreshToken(botToken);
  // Never a valid login: a real argon2 hash of an unguessable, never-stored secret — not a
  // malformed string, so login's verifyPassword() just returns false normally instead of
  // throwing on a bad hash format if someone ever tries the bot's placeholder email/username.
  const unusablePasswordHash = await hashPassword(crypto.randomBytes(32).toString("hex"));
  const placeholderEmail = `bot-${crypto.randomUUID()}@bots.lumina.internal`;

  const { app, botUser } = await prisma.$transaction(async (tx) => {
    const createdApp = await tx.application.create({
      data: { ownerId: params.ownerId, name, description: params.description?.trim() || null, botTokenHash },
    });
    const createdBotUser = await tx.user.create({
      data: {
        username,
        displayName: name,
        email: placeholderEmail,
        passwordHash: unusablePasswordHash,
        isBot: true,
        applicationId: createdApp.id,
      },
      select: { id: true, username: true },
    });
    return { app: createdApp, botUser: createdBotUser };
  });

  return { ...serializeApplication(app, botUser.id, botUser.username), botToken };
}

async function requireOwnedApplication(ownerId: string, applicationId: string) {
  const app = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!app) throw new NotFoundError("Application not found");
  if (app.ownerId !== ownerId) throw new ForbiddenError("You don't own this application");
  return app;
}

export async function regenerateBotToken(params: { ownerId: string; applicationId: string }): Promise<ApplicationWithTokenDTO> {
  const app = await requireOwnedApplication(params.ownerId, params.applicationId);
  const botToken = generateRefreshToken();
  const botTokenHash = hashRefreshToken(botToken);

  const [updated, botUser] = await Promise.all([
    prisma.application.update({ where: { id: app.id }, data: { botTokenHash } }),
    prisma.user.findUniqueOrThrow({ where: { applicationId: app.id }, select: { id: true, username: true } }),
  ]);

  return { ...serializeApplication(updated, botUser.id, botUser.username), botToken };
}

/** OAuth2 (modules/oauth2/) redirect URI allowlist — plain http(s) URL validation only; the
 * actual "does this exact string match what /oauth2/authorize was called with" check happens
 * at authorize/token time, not here. */
export async function updateRedirectUris(params: { ownerId: string; applicationId: string; redirectUris: string[] }): Promise<ApplicationDTO> {
  const app = await requireOwnedApplication(params.ownerId, params.applicationId);
  const updated = await prisma.application.update({ where: { id: app.id }, data: { redirectUris: params.redirectUris } });
  const botUser = await prisma.user.findUniqueOrThrow({ where: { applicationId: app.id }, select: { id: true, username: true } });
  return serializeApplication(updated, botUser.id, botUser.username);
}

export async function regenerateClientSecret(params: { ownerId: string; applicationId: string }): Promise<ApplicationWithClientSecretDTO> {
  const app = await requireOwnedApplication(params.ownerId, params.applicationId);
  if (app.redirectUris.length === 0) {
    throw new BadRequestError("Add at least one redirect URI before generating a client secret");
  }
  const clientSecret = generateRefreshToken();
  const clientSecretHash = hashRefreshToken(clientSecret);

  const [updated, botUser] = await Promise.all([
    prisma.application.update({ where: { id: app.id }, data: { clientSecretHash } }),
    prisma.user.findUniqueOrThrow({ where: { applicationId: app.id }, select: { id: true, username: true } }),
  ]);

  return { ...serializeApplication(updated, botUser.id, botUser.username), clientSecret };
}

export async function deleteApplication(params: { ownerId: string; applicationId: string }): Promise<void> {
  await requireOwnedApplication(params.ownerId, params.applicationId);
  // The bot User row cascades on delete (User.applicationId onDelete: Cascade in schema.prisma)
  // — deletes memberships, messages get authorId SetNull like any other deleted user, etc.
  await prisma.application.delete({ where: { id: params.applicationId } });
}
