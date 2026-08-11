import { prisma } from "../../db/prisma.js";

/**
 * Tags on the video feed.
 *
 * Normalisation is the whole design. "Gaming", "gaming" and " Gaming " must resolve to ONE tag —
 * without that the index fragments the moment two people type the same word slightly differently,
 * and a tag search stops returning what it should. The normalised form is the unique key; the
 * casing the creator typed is kept separately for display.
 */

export const MAX_TAGS_PER_VIDEO = 8;
const MAX_TAG_LENGTH = 30;
const MIN_TAG_LENGTH = 2;

/** Lowercased, trimmed, inner whitespace collapsed to single hyphens, and stripped of anything that
 * isn't a letter, number or hyphen — so a tag can never carry markup, emoji-only content, or the
 * invisible characters used to make two visually identical tags distinct. */
export function normaliseTag(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (cleaned.length < MIN_TAG_LENGTH || cleaned.length > MAX_TAG_LENGTH) return null;
  // A tag of only digits is almost always a mistyped year or a stray number, and pollutes search.
  if (/^\d+$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Resolves a list of raw tag strings to Tag rows, creating any that don't exist.
 *
 * Deduplicates after normalising, so submitting "Gaming" and "gaming" together counts once rather
 * than failing on the unique constraint.
 */
export async function resolveTags(
  rawTags: string[],
  createdById: string,
): Promise<Array<{ id: string; name: string; displayName: string }>> {
  const seen = new Map<string, string>();
  for (const raw of rawTags.slice(0, MAX_TAGS_PER_VIDEO * 2)) {
    const name = normaliseTag(raw);
    if (name && !seen.has(name)) seen.set(name, raw.trim().slice(0, MAX_TAG_LENGTH));
    if (seen.size >= MAX_TAGS_PER_VIDEO) break;
  }
  if (seen.size === 0) return [];

  const names = Array.from(seen.keys());
  const existing = await prisma.tag.findMany({ where: { name: { in: names } } });
  const existingByName = new Map(existing.map((t) => [t.name, t]));

  const toCreate = names.filter((n) => !existingByName.has(n));
  if (toCreate.length > 0) {
    // skipDuplicates because two uploads can create the same new tag concurrently; losing that race
    // should be a no-op, not a failed upload.
    await prisma.tag.createMany({
      data: toCreate.map((name) => ({ name, displayName: seen.get(name) ?? name, createdById })),
      skipDuplicates: true,
    });
  }

  return prisma.tag.findMany({
    where: { name: { in: names } },
    select: { id: true, name: true, displayName: true },
  });
}

/** Attaches tags to a video and keeps the denormalised useCount in step. */
export async function attachTags(videoId: bigint, tagIds: string[]): Promise<void> {
  if (tagIds.length === 0) return;
  await prisma.$transaction([
    prisma.videoTag.createMany({
      data: tagIds.map((tagId) => ({ videoId, tagId })),
      skipDuplicates: true,
    }),
    prisma.tag.updateMany({ where: { id: { in: tagIds } }, data: { useCount: { increment: 1 } } }),
  ]);
}

/**
 * Tag typeahead.
 *
 * Ranks exact, then prefix, then substring, then by how often the tag is actually used — the same
 * ordering rule as the people search, for the same reason: typing a tag in full and finding it
 * ranked fourth is what makes a picker feel broken.
 */
export async function searchTags(query: string, limit = 10) {
  const q = normaliseTag(query) ?? query.trim().toLowerCase();
  if (!q) {
    return prisma.tag.findMany({
      orderBy: { useCount: "desc" },
      take: limit,
      select: { id: true, name: true, displayName: true, useCount: true },
    });
  }

  const candidates = await prisma.tag.findMany({
    where: { name: { contains: q } },
    take: limit * 4,
    select: { id: true, name: true, displayName: true, useCount: true },
  });

  return candidates
    .sort((a, b) => {
      const score = (n: string) => (n === q ? 3 : n.startsWith(q) ? 2 : 1);
      return score(b.name) - score(a.name) || b.useCount - a.useCount || a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}
