import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { BadRequestError } from "./errors.js";
import { fitImage, type ImagePreset } from "./imageFit.js";

/**
 * The one place a profile image goes from "multipart part" to "URL on the record".
 *
 * All four surfaces (user avatar/banner, server icon/banner) previously inlined the same eight
 * lines with slightly different variable names, which is how the SVG hole and the
 * never-cleaned-up-old-file leak ended up in four places at once.
 */

export type ProfileImageDir = "avatars" | "banners" | "server-icons" | "server-banners" | "emojis" | "stickers";

interface UploadedPart {
  filename: string;
  mimetype: string;
  toBuffer: () => Promise<Buffer>;
}

export async function saveProfileImage(
  ownerId: string,
  dir: ProfileImageDir,
  preset: ImagePreset,
  file: UploadedPart | undefined,
  label: string,
): Promise<string> {
  if (!file) throw new BadRequestError("No file uploaded");
  // Still checked, even though fitImage would reject an undecodable file anyway: it produces a
  // clearer message for the overwhelmingly common mistake (picking a PDF or a .mov) than
  // "isn't a readable image" does.
  if (!file.mimetype.startsWith("image/")) {
    throw new BadRequestError(`${label} must be an image`);
  }

  const fitted = await fitImage(await file.toBuffer(), preset);

  const targetDir = path.join(env.UPLOADS_DIR, dir);
  await fs.mkdir(targetDir, { recursive: true });
  const fileName = `${ownerId}-${randomUUID()}.${fitted.extension}`;
  await fs.writeFile(path.join(targetDir, fileName), fitted.data);

  return `/${dir}/${fileName}`;
}

/**
 * Removes the file a record used to point at, after it has been replaced.
 *
 * Without this every avatar change leaked its predecessor forever — on a single host with no
 * object storage, where the same volume also holds video, that is a slow disk leak with no upper
 * bound.
 *
 * Deliberately derives the path from the exact URL stored on the row rather than globbing the
 * directory for anything matching the owner's id: a glob would delete files belonging to rows
 * that still reference them, and this codebase has already lost media once to exactly that
 * shortcut. `path.basename` makes a stored value like `/avatars/../../secrets` collapse to a
 * harmless filename before it is ever joined.
 */
export async function deleteProfileImage(previousUrl: string | null | undefined): Promise<void> {
  if (!previousUrl) return;
  const match = /^\/(avatars|banners|server-icons|server-banners|emojis|stickers)\/([^/]+)$/.exec(previousUrl);
  if (!match) return; // externally-hosted or hand-set URL: not ours to delete

  const [, dir, name] = match;
  try {
    await fs.unlink(path.join(env.UPLOADS_DIR, dir, path.basename(name)));
  } catch {
    // Already gone, or never written. Failing an otherwise-successful upload because the old
    // file couldn't be tidied would be the wrong trade.
  }
}
