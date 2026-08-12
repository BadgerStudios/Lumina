import { prisma } from "../../db/prisma.js";
import { redis } from "../../db/redis.js";
import { BadRequestError, ForbiddenError } from "../../lib/errors.js";

/**
 * AutoMod — per-server keyword rules, checked on every message send.
 *
 * ## Why this is deliberately small
 *
 * v1 blocks the send and does nothing else. No timeouts, no auto-deletion, no notification fan-out.
 * A rule engine with four actions is four features whose interactions have to be reasoned about
 * (what happens when a rule times someone out and another deletes the message that triggered it?),
 * and the one that actually stops the message is the one worth having first.
 *
 * ## Substring by default, not word-boundary
 *
 * The common rule is "block this slur", and slurs get padded, hyphenated and letter-swapped to
 * evade word matching. So the default is substring. `wholeWord` exists because the opposite failure
 * is real and worse when it happens: a term that appears inside ordinary words blocks innocent
 * messages, and the person who typed one gets no explanation. Per-rule, so an operator can pick.
 *
 * ## The performance shape
 *
 * This runs on EVERY message in EVERY channel, so it must not be a database query per send. Rules
 * are cached in Redis per server and invalidated on write — the same pattern as the addon runtime,
 * which had exactly this problem before it was cached.
 */

const CACHE_PREFIX = "automod:rules:";
const CACHE_TTL_SEC = 300;

export interface CompiledRule {
  id: string;
  name: string;
  terms: string[];
  wholeWord: boolean;
  exemptRoleIds: string[];
}

export async function loadRules(serverId: string): Promise<CompiledRule[]> {
  try {
    const cached = await redis.get(`${CACHE_PREFIX}${serverId}`);
    if (cached !== null) return JSON.parse(cached) as CompiledRule[];
  } catch {
    /* Redis down — fall through to the database rather than skipping moderation */
  }

  const rules = await prisma.autoModRule.findMany({
    where: { serverId, enabled: true },
    include: { terms: { select: { term: true } } },
  });
  const compiled: CompiledRule[] = rules.map((r) => ({
    id: r.id,
    name: r.name,
    terms: r.terms.map((t) => t.term),
    wholeWord: r.wholeWord,
    exemptRoleIds: r.exemptRoleIds,
  }));

  try {
    await redis.set(`${CACHE_PREFIX}${serverId}`, JSON.stringify(compiled), "EX", CACHE_TTL_SEC);
  } catch {
    /* caching is an optimisation */
  }
  return compiled;
}

export async function invalidate(serverId: string): Promise<void> {
  try {
    await redis.del(`${CACHE_PREFIX}${serverId}`);
  } catch {
    /* the TTL will catch up within five minutes */
  }
}

/**
 * Normalisation applied to both the message and the terms before comparing.
 *
 * Lowercase, and collapse the separators people insert to slip past a literal match — "s p a m",
 * "s.p.a.m", "s-p-a-m". Deliberately NOT full unicode confusable folding: that is a much larger
 * problem, and a half-implementation gives false confidence while still missing most of it.
 */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[\s._\-*|]+/g, "");
}

/** Escapes a term for safe use inside a RegExp — a rule containing `.` or `(` must match those
 * characters literally, not act as a pattern the operator did not intend. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface Match {
  ruleId: string;
  ruleName: string;
  term: string;
}

/**
 * Returns the first matching rule, or null.
 *
 * First rather than all: the caller blocks on any match, so evaluating the rest is work whose
 * result is discarded — and on a busy server this is on the hot path of every message.
 */
export function matchContent(
  content: string,
  rules: CompiledRule[],
  memberRoleIds: string[] = [],
): Match | null {
  if (!content) return null;
  const roleSet = new Set(memberRoleIds);
  const collapsed = normalise(content);
  const lowered = content.toLowerCase();

  for (const rule of rules) {
    // Exempt roles: a moderator discussing the term they moderate must not be blocked by their own
    // rule. Checked per rule, not globally, so one exemption does not disable the rest.
    if (rule.exemptRoleIds.some((id) => roleSet.has(id))) continue;

    for (const term of rule.terms) {
      if (!term) continue;
      if (rule.wholeWord) {
        // \b against the ORIGINAL text: collapsing separators would destroy the word boundaries
        // this mode exists to respect.
        const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
        if (pattern.test(lowered)) return { ruleId: rule.id, ruleName: rule.name, term };
      } else if (lowered.includes(term) || collapsed.includes(normalise(term))) {
        return { ruleId: rule.id, ruleName: rule.name, term };
      }
    }
  }
  return null;
}

/** Throws if the message violates a rule. Called from createChannelMessage. */
export async function assertPassesAutoMod(params: {
  serverId: string;
  content: string;
  memberRoleIds: string[];
}): Promise<void> {
  const rules = await loadRules(params.serverId);
  if (rules.length === 0) return;

  const match = matchContent(params.content, rules, params.memberRoleIds);
  if (!match) return;

  // The rule NAME is disclosed, the matched term is not. An operator names a rule for humans
  // ("No advertising"), which tells the sender what they did wrong — while echoing the term back
  // would turn the error into an oracle for probing the blocklist word by word.
  throw new ForbiddenError(`Blocked by this server's moderation rule: ${match.ruleName}`);
}

// ---- management ------------------------------------------------------------------------------

export async function listRules(serverId: string) {
  const rules = await prisma.autoModRule.findMany({
    where: { serverId },
    orderBy: { createdAt: "asc" },
    include: { terms: { select: { term: true } } },
  });
  return rules.map((r) => ({
    id: r.id,
    name: r.name,
    terms: r.terms.map((t) => t.term),
    wholeWord: r.wholeWord,
    enabled: r.enabled,
    exemptRoleIds: r.exemptRoleIds,
    createdAt: r.createdAt.toISOString(),
  }));
}

const MAX_TERMS = 200;

function cleanTerms(terms: string[]): string[] {
  const cleaned = terms
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, MAX_TERMS);
  // Deduplicated: the same term twice does nothing except make the rule slower on every message.
  return Array.from(new Set(cleaned));
}

export async function createRule(params: {
  serverId: string;
  name: string;
  terms: string[];
  wholeWord?: boolean;
  exemptRoleIds?: string[];
  createdById: string;
}) {
  const terms = cleanTerms(params.terms);
  if (terms.length === 0) throw new BadRequestError("A rule needs at least one term");

  const rule = await prisma.autoModRule.create({
    data: {
      serverId: params.serverId,
      name: params.name.trim().slice(0, 80),
      wholeWord: params.wholeWord ?? false,
      exemptRoleIds: params.exemptRoleIds ?? [],
      createdById: params.createdById,
      terms: { create: terms.map((term) => ({ term })) },
    },
  });
  await invalidate(params.serverId);
  return rule.id;
}

export async function updateRule(params: {
  serverId: string;
  ruleId: string;
  name?: string;
  terms?: string[];
  wholeWord?: boolean;
  enabled?: boolean;
  exemptRoleIds?: string[];
}) {
  // Scoped by serverId as well as id, so a rule id from another server cannot be edited by
  // guessing it.
  const existing = await prisma.autoModRule.findFirst({
    where: { id: params.ruleId, serverId: params.serverId },
    select: { id: true },
  });
  if (!existing) throw new BadRequestError("No such rule");

  const terms = params.terms ? cleanTerms(params.terms) : undefined;
  if (terms && terms.length === 0) throw new BadRequestError("A rule needs at least one term");

  await prisma.$transaction(async (tx) => {
    await tx.autoModRule.update({
      where: { id: params.ruleId },
      data: {
        ...(params.name !== undefined ? { name: params.name.trim().slice(0, 80) } : {}),
        ...(params.wholeWord !== undefined ? { wholeWord: params.wholeWord } : {}),
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        ...(params.exemptRoleIds !== undefined ? { exemptRoleIds: params.exemptRoleIds } : {}),
      },
    });
    if (terms) {
      // Replaced wholesale rather than diffed: the term list is small and edited as a block in the
      // UI, and a diff here is more code with more ways to leave the set half-updated.
      await tx.autoModTerm.deleteMany({ where: { ruleId: params.ruleId } });
      await tx.autoModTerm.createMany({
        data: terms.map((term) => ({ ruleId: params.ruleId, term })),
      });
    }
  });
  await invalidate(params.serverId);
}

export async function deleteRule(serverId: string, ruleId: string): Promise<void> {
  const result = await prisma.autoModRule.deleteMany({ where: { id: ruleId, serverId } });
  if (result.count === 0) throw new BadRequestError("No such rule");
  await invalidate(serverId);
}
