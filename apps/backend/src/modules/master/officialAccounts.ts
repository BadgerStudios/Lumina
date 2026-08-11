import path from "node:path";
import fs from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import { hashPassword } from "../../lib/password.js";
import { fitImage } from "../../lib/imageFit.js";
import { BadRequestError, ConflictError } from "../../lib/errors.js";

/**
 * Minting first-party Lumina accounts.
 *
 * ## Why this is a feature and not just "make an account and set the bio"
 *
 * Anyone can already set their bio to "Official Lumina Staff" and upload the logo as their avatar.
 * On a platform where real staff message people about moderation decisions, that is a working
 * phishing kit — and the only defence that survives contact with a determined impersonator is a
 * marker the impersonator cannot set. So the generator's real output isn't the bio or the picture,
 * it's `User.isOfficial`, which is writable from here and nowhere else, and which renders as a
 * badge next to the name.
 *
 * ## Password handling
 *
 * The generated password is returned exactly once, in the response that creates the account, and
 * is never stored in readable form or written to a log. If it is lost the account is reset like
 * any other — that is strictly better than keeping a retrievable copy of a staff credential.
 */

export const OFFICIAL_BIO = "Official Lumina Staff";

/** Where the logo lives inside the runtime image (see the Dockerfile's assets COPY). Resolved from
 * the process cwd, which is /app in the container and apps/backend when run locally. */
const LOGO_PATH = path.resolve(process.cwd(), "assets/lumina-logo.png");

export interface GeneratedAccount {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
  /** Shown once, then unrecoverable. */
  password: string;
}

export async function generateOfficialAccount(params: {
  username: string;
  displayName?: string | null;
  bio?: string | null;
}): Promise<GeneratedAccount> {
  const username = params.username.trim();
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    throw new BadRequestError("Username must be 3-32 letters, numbers or underscores");
  }

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) throw new ConflictError("That username is taken");

  // A routable address on the instance's own domain rather than a real inbox: these accounts are
  // never meant to receive mail, and pointing them at a personal address would mean a password
  // reset on a staff account lands in someone's private inbox.
  const email = `${username.toLowerCase()}@official.lumina.local`;

  // 24 bytes of base64url. Long enough that it is never guessed, and generated here rather than
  // chosen so nobody reuses a password they already use somewhere else on a privileged account.
  const password = randomBytes(24).toString("base64url");

  const avatarUrl = await writeLogoAvatar(username);

  const user = await prisma.user.create({
    data: {
      username,
      displayName: params.displayName?.trim() || username,
      email,
      passwordHash: await hashPassword(password),
      avatarUrl,
      bio: (params.bio?.trim() || OFFICIAL_BIO).slice(0, 190),
      isOfficial: true,
      // Age is recorded so these accounts aren't caught by the adult gate on the feed and by
      // canContact() — an official account that cannot be messaged is not much use as a support
      // account. A first-party account is not a person, so the date is nominal rather than false
      // about anyone.
      ageBracket: "AGE_25_34",
      birthDate: new Date("1990-01-01"),
      isMinor: false,
      ageRecordedAt: new Date(),
      // Deliberately NOT granted staff powers. An identity badge and a permission tier are
      // different things, and conflating them means every support account gets moderation
      // authority it doesn't need. Grant that separately, per account, if it's actually wanted.
      platformRole: "USER",
    },
  });

  return { id: user.id, username: user.username, displayName: user.displayName, email: user.email, password };
}

/**
 * Writes the logo through the same crop/encode pipeline as a user upload.
 *
 * Not a shortcut of pointing every official account at one shared file: each gets its own copy, so
 * an account can later change its picture without silently changing everyone else's, and deleting
 * one account's avatar can never blank the others.
 */
async function writeLogoAvatar(username: string): Promise<string> {
  const source = await fs.readFile(LOGO_PATH);
  const fitted = await fitImage(source, "avatar");

  const dir = path.join(env.UPLOADS_DIR, "avatars");
  await fs.mkdir(dir, { recursive: true });
  const fileName = `official-${username.toLowerCase()}-${randomUUID()}.${fitted.extension}`;
  await fs.writeFile(path.join(dir, fileName), fitted.data);
  return `/avatars/${fileName}`;
}

export async function listOfficialAccounts() {
  const users = await prisma.user.findMany({
    where: { isOfficial: true },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
      bio: true,
      platformRole: true,
      isBot: true,
      createdAt: true,
    },
  });
  return users.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() }));
}

/** Turning the badge off is as important as turning it on: an account that stops being official
 * must stop looking official immediately, without deleting its history. */
export async function setOfficial(userId: string, isOfficial: boolean) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { isOfficial },
    select: { id: true, username: true, isOfficial: true },
  });
  return user;
}
