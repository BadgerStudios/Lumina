import { prisma } from "../../db/prisma.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../lib/errors.js";

/**
 * Server onboarding — what someone sees in their first five minutes.
 *
 * The single largest retention lever in the research behind this: a short orientation before the
 * full channel list takes first-week retention from 12-18% to 43-67%. The mechanism is not the
 * welcome text. It is that answering two questions grants roles, and roles make a hundred-channel
 * server look like the six channels that person actually came for.
 *
 * Deliberately not a wizard with a progress bar. Every prompt is optional unless the server made
 * rules mandatory, and skipping lands you in the server anyway — an orientation that can trap
 * somebody is a worse first impression than no orientation.
 */

export interface OnboardingConfig {
  enabled: boolean;
  welcomeTitle: string | null;
  welcomeBody: string | null;
  rules: string | null;
  requireRules: boolean;
  prompts: Array<{
    id: string;
    title: string;
    multiple: boolean;
    options: Array<{
      id: string;
      label: string;
      description: string | null;
      emoji: string | null;
      roleIds: string[];
    }>;
  }>;
}

export async function getOnboarding(serverId: string): Promise<OnboardingConfig> {
  const row = await prisma.serverOnboarding.findUnique({
    where: { serverId },
    include: {
      prompts: {
        orderBy: { position: "asc" },
        include: { options: { orderBy: { position: "asc" } } },
      },
    },
  });

  // A server that has never configured onboarding is not an error — it is the default, and the
  // editor needs an empty shape to start from rather than a 404 to special-case.
  if (!row) {
    return {
      enabled: false,
      welcomeTitle: null,
      welcomeBody: null,
      rules: null,
      requireRules: false,
      prompts: [],
    };
  }

  return {
    enabled: row.enabled,
    welcomeTitle: row.welcomeTitle,
    welcomeBody: row.welcomeBody,
    rules: row.rules,
    requireRules: row.requireRules,
    prompts: row.prompts.map((p) => ({
      id: p.id,
      title: p.title,
      multiple: p.multiple,
      options: p.options.map((o) => ({
        id: o.id,
        label: o.label,
        description: o.description,
        emoji: o.emoji,
        roleIds: o.roleIds,
      })),
    })),
  };
}

export interface SaveOnboardingInput {
  enabled: boolean;
  welcomeTitle?: string | null;
  welcomeBody?: string | null;
  rules?: string | null;
  requireRules: boolean;
  prompts: Array<{
    title: string;
    multiple: boolean;
    options: Array<{
      label: string;
      description?: string | null;
      emoji?: string | null;
      roleIds: string[];
    }>;
  }>;
}

/**
 * Replace the whole configuration.
 *
 * Wholesale rather than per-prompt edits: the editor is a form someone fills in and saves, and
 * reconciling "which of these five prompts is the one that used to be third" is complexity with no
 * user-visible payoff. Prompt ids are therefore not stable across a save, which is fine because
 * nothing stores an answer against them — see completeOnboarding, which grants roles immediately
 * rather than recording which button produced them.
 */
export async function saveOnboarding(serverId: string, input: SaveOnboardingInput): Promise<OnboardingConfig> {
  // Roles are validated against THIS server. Without it, an option could be made to grant a role
  // from another server entirely — a privilege escalation dressed up as a typo.
  const referenced = [...new Set(input.prompts.flatMap((p) => p.options.flatMap((o) => o.roleIds)))];
  if (referenced.length > 0) {
    const valid = await prisma.role.findMany({
      where: { id: { in: referenced }, serverId },
      select: { id: true },
    });
    if (valid.length !== referenced.length) {
      throw new BadRequestError("One of those options grants a role that doesn't belong to this server");
    }
  }

  if (input.requireRules && !input.rules?.trim()) {
    throw new BadRequestError("You can't require rules without writing any");
  }

  await prisma.$transaction(async (tx) => {
    await tx.serverOnboarding.upsert({
      where: { serverId },
      create: {
        serverId,
        enabled: input.enabled,
        welcomeTitle: input.welcomeTitle?.slice(0, 120) ?? null,
        welcomeBody: input.welcomeBody?.slice(0, 1000) ?? null,
        rules: input.rules?.slice(0, 4000) ?? null,
        requireRules: input.requireRules,
      },
      update: {
        enabled: input.enabled,
        welcomeTitle: input.welcomeTitle?.slice(0, 120) ?? null,
        welcomeBody: input.welcomeBody?.slice(0, 1000) ?? null,
        rules: input.rules?.slice(0, 4000) ?? null,
        requireRules: input.requireRules,
      },
    });

    // Prompts cascade to their options, so one delete clears both levels.
    await tx.onboardingPrompt.deleteMany({ where: { serverId } });

    for (const [i, prompt] of input.prompts.entries()) {
      await tx.onboardingPrompt.create({
        data: {
          serverId,
          title: prompt.title.slice(0, 120),
          multiple: prompt.multiple,
          position: i,
          options: {
            create: prompt.options.map((o, j) => ({
              label: o.label.slice(0, 80),
              description: o.description?.slice(0, 200) ?? null,
              emoji: o.emoji?.slice(0, 16) ?? null,
              roleIds: o.roleIds,
              position: j,
            })),
          },
        },
      });
    }
  });

  return getOnboarding(serverId);
}

export interface MemberOnboardingState {
  config: OnboardingConfig;
  /** Null when this person is not a member — the invite preview reads the same endpoint. */
  onboardedAt: string | null;
  rulesAcceptedAt: string | null;
  /** True when the welcome screen should be put in front of them right now. */
  due: boolean;
}

export async function getMemberState(serverId: string, userId: string): Promise<MemberOnboardingState> {
  const [config, membership] = await Promise.all([
    getOnboarding(serverId),
    prisma.membership.findUnique({
      where: { userId_serverId: { userId, serverId } },
      select: { onboardedAt: true, rulesAcceptedAt: true },
    }),
  ]);

  const needsRules = config.requireRules && !membership?.rulesAcceptedAt;
  return {
    config,
    onboardedAt: membership?.onboardedAt?.toISOString() ?? null,
    rulesAcceptedAt: membership?.rulesAcceptedAt?.toISOString() ?? null,
    // Outstanding rules re-open the screen even for someone who went through it before the server
    // started requiring them — otherwise an existing member silently loses the ability to post with
    // nothing on screen explaining why.
    due: Boolean(membership) && config.enabled && (!membership?.onboardedAt || needsRules),
  };
}

export async function completeOnboarding(params: {
  serverId: string;
  userId: string;
  optionIds: string[];
  acceptedRules: boolean;
}): Promise<MemberOnboardingState> {
  const membership = await prisma.membership.findUnique({
    where: { userId_serverId: { userId: params.userId, serverId: params.serverId } },
    select: { id: true },
  });
  if (!membership) throw new ForbiddenError("Not a member of this server");

  const config = await prisma.serverOnboarding.findUnique({ where: { serverId: params.serverId } });
  if (config?.requireRules && !params.acceptedRules) {
    throw new BadRequestError("You have to accept the rules to continue");
  }

  // Options are re-read from the database rather than trusted from the request. The client sends
  // ids; the roles those ids grant are decided here, or picking an option would be a way to ask for
  // any role in the server by name.
  const options = params.optionIds.length
    ? await prisma.onboardingOption.findMany({
        where: { id: { in: params.optionIds }, prompt: { serverId: params.serverId } },
        select: { roleIds: true },
      })
    : [];

  const roleIds = [...new Set(options.flatMap((o) => o.roleIds))];
  if (roleIds.length > 0) {
    // Validated again against the server: a role could have been deleted, or moved, between the
    // configuration being saved and this member answering.
    const valid = await prisma.role.findMany({
      where: { id: { in: roleIds }, serverId: params.serverId },
      select: { id: true },
    });
    await prisma.roleAssignment.createMany({
      data: valid.map((r) => ({ membershipId: membership.id, roleId: r.id })),
      // Already holding a role granted by an option is the normal case when someone re-runs
      // onboarding after the rules changed.
      skipDuplicates: true,
    });
  }

  await prisma.membership.update({
    where: { id: membership.id },
    data: {
      onboardedAt: new Date(),
      ...(params.acceptedRules ? { rulesAcceptedAt: new Date() } : {}),
    },
  });

  return getMemberState(params.serverId, params.userId);
}

/**
 * The posting gate.
 *
 * A PURE function, deliberately. The message path already reads the membership row to check for a
 * timeout, and that read now joins the server's onboarding config — so the gate costs no extra
 * round trip at all. Doing the lookup in here instead would have added one query to every message
 * sent on the platform to answer a question that is "no" for almost every server.
 *
 * Permissive by default: a server with no onboarding, or with rules it does not require, never
 * reaches the throw.
 */
export function assertRulesAccepted(
  onboarding: { enabled: boolean; requireRules: boolean } | null | undefined,
  membership: { rulesAcceptedAt: Date | null },
): void {
  if (!onboarding?.enabled || !onboarding.requireRules) return;
  if (membership.rulesAcceptedAt) return;
  throw new ForbiddenError("Accept this server's rules before posting");
}
