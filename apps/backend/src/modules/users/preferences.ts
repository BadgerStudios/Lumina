import { z } from "zod";
import { DEFAULT_PREFERENCES, PUSH_KINDS, type UserPreferencesDTO } from "@lumina/shared";
import { BadRequestError } from "../../lib/errors.js";

/**
 * Account preferences: the per-person switches that shape the app everywhere the person signs
 * in — how Enter behaves, whether media and previews render, clock format, motion, text size,
 * which pushes may ring. Stored as one JSON column on the User row rather than a column per
 * switch, because the set will keep growing and every switch has a default; unknown or invalid
 * stored values simply fall back to the default instead of failing the whole read.
 *
 * Pure: resolve/merge take and return plain objects, so the rules are unit-tested directly.
 */

const chatSchema = z.object({
  sendWithEnter: z.boolean(),
  showLinkPreviews: z.boolean(),
  showMedia: z.boolean(),
  use24hClock: z.boolean(),
  showJoinLeaveLines: z.boolean(),
});
const accessibilitySchema = z.object({
  reducedMotion: z.boolean(),
  fontScale: z.union([z.literal(90), z.literal(100), z.literal(110), z.literal(125)]),
});
const pushSchema = z.object(Object.fromEntries(PUSH_KINDS.map((k) => [k, z.boolean()])) as Record<(typeof PUSH_KINDS)[number], z.ZodBoolean>);
const notificationsSchema = z.object({ push: pushSchema });

export const preferencesSchema = z.object({
  chat: chatSchema,
  accessibility: accessibilitySchema,
  notifications: notificationsSchema,
});

export const preferencesPatchSchema = z.object({
  chat: chatSchema.partial().optional(),
  accessibility: accessibilitySchema.partial().optional(),
  notifications: z.object({ push: pushSchema.partial().optional() }).optional(),
});
export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Defaults, overlaid with whatever stored values are still valid. Never throws. */
export function resolvePreferences(stored: unknown): UserPreferencesDTO {
  const out: UserPreferencesDTO = structuredClone(DEFAULT_PREFERENCES);
  if (!isRecord(stored)) return out;
  const parsed = preferencesPatchSchema.safeParse(pruneInvalid(stored));
  if (!parsed.success) return out;
  return overlay(out, parsed.data);
}

/** A stored blob may carry values from an older or newer app; keep only the leaves that still validate. */
function pruneInvalid(stored: Record<string, unknown>): Record<string, unknown> {
  const keep: Record<string, unknown> = {};
  for (const [section, schema] of Object.entries({ chat: chatSchema, accessibility: accessibilitySchema }) as Array<[keyof UserPreferencesDTO, z.ZodObject<z.ZodRawShape>]>) {
    const value = stored[section];
    if (!isRecord(value)) continue;
    const pruned: Record<string, unknown> = {};
    for (const [key, leaf] of Object.entries(schema.shape)) {
      if (key in value && leaf.safeParse(value[key]).success) pruned[key] = value[key];
    }
    keep[section] = pruned;
  }
  const notif = stored.notifications;
  if (isRecord(notif) && isRecord(notif.push)) {
    const push: Record<string, unknown> = {};
    for (const kind of PUSH_KINDS) if (typeof notif.push[kind] === "boolean") push[kind] = notif.push[kind];
    keep.notifications = { push };
  }
  return keep;
}

function overlay(base: UserPreferencesDTO, patch: PreferencesPatch): UserPreferencesDTO {
  return {
    chat: { ...base.chat, ...(patch.chat ?? {}) },
    accessibility: { ...base.accessibility, ...(patch.accessibility ?? {}) },
    notifications: { push: { ...base.notifications.push, ...(patch.notifications?.push ?? {}) } },
  };
}

/** The full set after applying a partial change; an invalid change is refused with a readable reason. */
export function mergePreferences(stored: unknown, patch: unknown): UserPreferencesDTO {
  const parsed = preferencesPatchSchema.safeParse(patch);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BadRequestError(`Preference ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  return overlay(resolvePreferences(stored), parsed.data);
}
