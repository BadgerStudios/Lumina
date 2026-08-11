import { z } from "zod";

/**
 * The addon manifest: the complete vocabulary an addon is allowed to express.
 *
 * This file IS the security boundary. There is no sandbox to harden and no interpreter to audit,
 * because an addon cannot say anything that isn't in this schema — it has no way to describe
 * "run this", "fetch that URL", or "read those rows". Adding a capability means adding it here
 * deliberately, which is exactly the review step an executable plugin format doesn't have.
 *
 * Two things are deliberately absent, and both were considered rather than forgotten:
 *
 * - **Regular expressions.** A user-supplied pattern is a denial of service waiting to happen
 *   (catastrophic backtracking on every message send), and keyword matching covers what people
 *   actually write these automations for.
 * - **Role changes.** `addRole` is the action every addon system eventually grows and the one that
 *   turns an addon into a privilege-escalation primitive: an addon that can grant a role can grant
 *   a role that has ADMINISTRATOR. Adding it safely means resolving role hierarchy against the
 *   installer at execution time, which is a real design step and not a line of code.
 */

/** Bounded so the per-message cost of having addons installed stays bounded too. A server with
 * five addons at ten automations each is 50 predicate evaluations per message, all in memory. */
export const MAX_AUTOMATIONS = 10;
export const MAX_ACTIONS_PER_AUTOMATION = 3;
export const MAX_KEYWORDS = 20;

const keyword = z.string().min(1).max(60);

const conditionSchema = z
  .object({
    /** Case-insensitive substring match against the message content. Any one matching is enough. */
    contains: z.array(keyword).max(MAX_KEYWORDS).optional(),
    /** Case-insensitive prefix, for command-shaped triggers like "!help". */
    startsWith: z.array(keyword).max(MAX_KEYWORDS).optional(),
    /** Channel names, without the leading #. Empty or absent means every channel. */
    inChannels: z.array(z.string().min(1).max(100)).max(50).optional(),
    /** Message length bounds — the honest way to catch wall-of-text spam without a regex. */
    minLength: z.number().int().min(0).max(4000).optional(),
    maxLength: z.number().int().min(1).max(4000).optional(),
  })
  .strict();

const actionSchema = z.discriminatedUnion("type", [
  /** A unicode emoji reaction. No custom-emoji ids: those are per-server, and an addon published
   * once and installed anywhere cannot know them. */
  z.object({ type: z.literal("react"), emoji: z.string().min(1).max(16) }).strict(),
  z.object({ type: z.literal("pin") }).strict(),
  z.object({ type: z.literal("delete") }).strict(),
  /**
   * A reply, posted as the publishing Application's bot user.
   *
   * An addon has no identity of its own to speak as, and inventing one (a null author, a fake
   * system user) means a message in the channel that nobody can hold accountable. Reusing the bot
   * that already exists means the reply goes through the normal message path with the normal
   * permission checks, and it appears as an identifiable account a moderator can remove.
   *
   * An addon without a bot simply cannot use this action — enforced at publish time.
   */
  z
    .object({
      type: z.literal("reply"),
      /** `{user}` is the only substitution. Anything richer becomes a templating language, and a
       * templating language is a program. */
      text: z.string().min(1).max(500),
    })
    .strict(),
]);

const automationSchema = z
  .object({
    name: z.string().min(1).max(80),
    /** One trigger today. An enum rather than a string so adding "member.join" later is a schema
     * change someone has to make on purpose. */
    on: z.enum(["message.create"]),
    when: conditionSchema,
    then: z.array(actionSchema).min(1).max(MAX_ACTIONS_PER_AUTOMATION),
  })
  .strict();

export const manifestSchema = z
  .object({
    /** Lowercase, hyphenated, stable. This is what a CLI publishes against and what an install
     * record points at, so it is validated tightly rather than accepted as any string. */
    slug: z
      .string()
      .min(3)
      .max(48)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase words separated by hyphens"),
    name: z.string().min(1).max(80),
    description: z.string().max(300).optional(),
    /** Semver. Compared on publish so a version can never go backwards, which is what stops a
     * stolen token from rolling every install back to a known-bad manifest. */
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver, e.g. 1.0.0"),
    automations: z.array(automationSchema).min(1).max(MAX_AUTOMATIONS),
  })
  .strict();

export type AddonManifest = z.infer<typeof manifestSchema>;
export type AddonAutomation = z.infer<typeof automationSchema>;
export type AddonAction = z.infer<typeof actionSchema>;

/** True when a manifest asks for anything that needs an identity to speak as. */
export function requiresBot(manifest: AddonManifest): boolean {
  return manifest.automations.some((a) => a.then.some((t) => t.type === "reply"));
}

/** Compares two semver strings. Returns > 0 when `a` is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}
