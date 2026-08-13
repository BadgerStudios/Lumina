import type {
  ApplicationDTO,
  WebhookDTO,
  FriendRequestDTO,
  AttachmentDTO,
  AuditLogEntryDTO,
  ChannelDTO,
  DMConversationDTO,
  InviteDTO,
  MemberDTO,
  MessageDTO,
  ReactionSummaryDTO,
  RoleDTO,
  ServerDTO,
  SessionDTO,
  UserDTO,
  ActionRowDTO,
  LinkPreviewDTO,
  MessageComponentDTO,
  PollDTO,
  SoundboardSoundDTO,
  StickerDTO,
} from "@lumina/shared";

type UserLike = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  statusText: string | null;
  statusEmoji: string | null;
  bio: string | null;
  bannerUrl: string | null;
  pronouns: string | null;
  presence: string;
  isBot: boolean;
  isOfficial?: boolean;
};

export function serializeUser(user: UserLike): UserDTO {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    statusText: user.statusText,
    statusEmoji: user.statusEmoji,
    bio: user.bio,
    bannerUrl: user.bannerUrl,
    pronouns: user.pronouns,
    presence: user.presence as UserDTO["presence"],
    isBot: user.isBot,
    isOfficial: user.isOfficial ?? false,
  };
}

type MeLike = UserLike & {
  allowDmsFromNonFriends: boolean;
  allowFriendRequests: boolean;
  platformRole: string;
  isMinor: boolean;
  ageRecordedAt: Date | null;
  emailVerifiedAt: Date | null;
};

/** Only for "this is the logged-in user's own record" responses (auth/routes.ts,
 * users/routes.ts PATCH /me) — the two privacy booleans are the account owner's own settings,
 * not something to leak on other users' profiles via the plain serializeUser above.
 *
 * platformRole rides here too (own-record only, never on serializeUser) purely so the client knows
 * whether to render the staff/owner nav entries. It is a presentation hint and nothing more — every
 * /api/staff and /api/owner route independently enforces requireStaff/requireOwner server-side, so a
 * user who forges this field locally gains a dead link and 403s, not access. */
export function serializeMe(user: MeLike): UserDTO {
  return {
    ...serializeUser(user),
    allowDmsFromNonFriends: user.allowDmsFromNonFriends,
    allowFriendRequests: user.allowFriendRequests,
    platformRole: user.platformRole as UserDTO["platformRole"],
    // Own-record only. `ageVerified: false` is what triggers the blocking age prompt for accounts
    // created before age collection existed; `isMinor` gates the adult-only surfaces client-side
    // (the server enforces the same on every route).
    ageVerified: user.ageRecordedAt !== null,
    isMinor: user.ageRecordedAt === null ? true : user.isMinor,
    // Own-record only, and purely presentational: it drives the "confirm your email" banner.
    // Nothing is gated on it — see modules/auth/emailVerification.ts.
    emailVerified: user.emailVerifiedAt !== null,
  };
}

type RoleLike = {
  id: string;
  serverId: string;
  name: string;
  color: number | null;
  permissions: bigint;
  position: number;
  isDefault: boolean;
  mentionable: boolean;
};

export function serializeRole(role: RoleLike): RoleDTO {
  return {
    id: role.id,
    serverId: role.serverId,
    name: role.name,
    color: role.color,
    permissions: role.permissions.toString(),
    position: role.position,
    isDefault: role.isDefault,
    mentionable: role.mentionable,
  };
}

type MembershipLike = {
  userId: string;
  serverId: string;
  nickname: string | null;
  mutedUntil: Date | null;
  joinedAt: Date;
  user: UserLike;
  roles: { roleId: string }[];
};

export function serializeMember(membership: MembershipLike): MemberDTO {
  return {
    userId: membership.userId,
    serverId: membership.serverId,
    nickname: membership.nickname,
    mutedUntil: membership.mutedUntil ? membership.mutedUntil.toISOString() : null,
    joinedAt: membership.joinedAt.toISOString(),
    user: serializeUser(membership.user),
    roleIds: membership.roles.map((r) => r.roleId),
  };
}

type ChannelLike = {
  id: string;
  serverId: string;
  name: string;
  type: string;
  topic: string | null;
  parentId: string | null;
  position: number;
  slowmodeSeconds: number;
  nsfw: boolean;
};

export function serializeChannel(channel: ChannelLike): ChannelDTO {
  return {
    id: channel.id,
    serverId: channel.serverId,
    name: channel.name,
    type: channel.type as ChannelDTO["type"],
    topic: channel.topic,
    parentId: channel.parentId,
    position: channel.position,
    slowmodeSeconds: channel.slowmodeSeconds,
    nsfw: channel.nsfw,
  };
}

type ServerLike = {
  id: string;
  name: string;
  iconUrl: string | null;
  bannerUrl: string | null;
  accentColor: number | null;
  ownerId: string;
  systemChannelId: string | null;
  createdAt: Date;
  description?: string | null;
  vanityCode?: string | null;
  verificationLevel?: string;
  explicitContentFilter?: string;
  defaultNotificationLevel?: string;
  afkChannelId?: string | null;
  afkTimeoutSec?: number;
  sysJoinMessages?: boolean;
  sysLeaveMessages?: boolean;
  sysBoostMessages?: boolean;
  rulesChannelId?: string | null;
  discoverable?: boolean;
  minecraftHost?: string | null;
};

export function serializeServer(server: ServerLike): ServerDTO {
  return {
    id: server.id,
    name: server.name,
    iconUrl: server.iconUrl,
    bannerUrl: server.bannerUrl,
    accentColor: server.accentColor,
    ownerId: server.ownerId,
    systemChannelId: server.systemChannelId,
    createdAt: server.createdAt.toISOString(),
    description: server.description ?? null,
    vanityCode: server.vanityCode ?? null,
    // Defaults mirror the schema's. Some call sites select a narrow subset of Server columns, and
    // a DTO whose settings silently read as undefined would make the settings UI show every toggle
    // in the wrong position.
    verificationLevel: (server.verificationLevel ?? "NONE") as ServerDTO["verificationLevel"],
    explicitContentFilter: (server.explicitContentFilter ?? "DISABLED") as ServerDTO["explicitContentFilter"],
    defaultNotificationLevel: (server.defaultNotificationLevel ?? "ALL") as ServerDTO["defaultNotificationLevel"],
    afkChannelId: server.afkChannelId ?? null,
    afkTimeoutSec: server.afkTimeoutSec ?? 300,
    sysJoinMessages: server.sysJoinMessages ?? true,
    sysLeaveMessages: server.sysLeaveMessages ?? false,
    sysBoostMessages: server.sysBoostMessages ?? true,
    rulesChannelId: server.rulesChannelId ?? null,
    discoverable: server.discoverable ?? false,
    minecraftHost: server.minecraftHost ?? null,
  };
}

type AttachmentLike = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  width: number | null;
  height: number | null;
};

export function serializeAttachment(attachment: AttachmentLike): AttachmentDTO {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    url: attachment.url,
    width: attachment.width,
    height: attachment.height,
  };
}

type ReactionLike = { emoji: string; userId: string };

export function summarizeReactions(reactions: ReactionLike[], currentUserId: string | null): ReactionSummaryDTO[] {
  const byEmoji = new Map<string, { count: number; reactedByMe: boolean }>();
  for (const r of reactions) {
    const entry = byEmoji.get(r.emoji) ?? { count: 0, reactedByMe: false };
    entry.count += 1;
    if (currentUserId && r.userId === currentUserId) entry.reactedByMe = true;
    byEmoji.set(r.emoji, entry);
  }
  return Array.from(byEmoji.entries()).map(([emoji, v]) => ({ emoji, count: v.count, reactedByMe: v.reactedByMe }));
}

type StickerLike = {
  id: string;
  serverId: string;
  name: string;
  description: string | null;
  imageUrl: string;
  animated: boolean;
  createdAt: Date;
};

export function serializeSticker(sticker: StickerLike): StickerDTO {
  return {
    id: sticker.id,
    serverId: sticker.serverId,
    name: sticker.name,
    description: sticker.description,
    imageUrl: sticker.imageUrl,
    animated: sticker.animated,
    createdAt: sticker.createdAt.toISOString(),
  };
}

type SoundLike = {
  id: string;
  serverId: string;
  name: string;
  audioUrl: string;
  emoji: string | null;
  durationMs: number;
  createdAt: Date;
};

export function serializeSound(sound: SoundLike): SoundboardSoundDTO {
  return {
    id: sound.id,
    serverId: sound.serverId,
    name: sound.name,
    audioUrl: sound.audioUrl,
    emoji: sound.emoji,
    durationMs: sound.durationMs,
    createdAt: sound.createdAt.toISOString(),
  };
}

type PollLike = {
  id: string;
  question: string;
  allowMultiple: boolean;
  expiresAt: Date | null;
  options: Array<{ id: string; label: string; position: number; votes: Array<{ userId: string }> }>;
};

/**
 * `closed` is computed here rather than sent as a raw expiry for the client to compare against its
 * own clock. A device with a slow clock would otherwise let someone vote in a poll that shut hours
 * ago — the vote route rejects it, but only after the UI has told them it worked.
 */
export function serializePoll(poll: PollLike, currentUserId: string | null): PollDTO {
  let totalVotes = 0;
  const options = poll.options
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((o) => {
      totalVotes += o.votes.length;
      return {
        id: o.id,
        label: o.label,
        position: o.position,
        votes: o.votes.length,
        votedByMe: currentUserId ? o.votes.some((v) => v.userId === currentUserId) : false,
      };
    });

  return {
    id: poll.id,
    question: poll.question,
    allowMultiple: poll.allowMultiple,
    expiresAt: poll.expiresAt ? poll.expiresAt.toISOString() : null,
    closed: poll.expiresAt !== null && poll.expiresAt.getTime() <= Date.now(),
    totalVotes,
    options,
  };
}

type EmbedLike = {
  position: number;
  preview: {
    url: string;
    status: string;
    title: string | null;
    description: string | null;
    imageUrl: string | null;
    siteName: string | null;
  };
};

/**
 * Only OK previews are serialized. A PENDING one has not been fetched yet, and EMPTY/BLOCKED/FAILED
 * are cached negatives — none of them has anything to draw, and sending an embed with every field
 * null would make clients render an empty card.
 */
function serializeEmbeds(embeds: EmbedLike[]): LinkPreviewDTO[] {
  return embeds
    .filter((e) => e.preview.status === "OK")
    .sort((a, b) => a.position - b.position)
    .map((e) => ({
      url: e.preview.url,
      title: e.preview.title,
      description: e.preview.description,
      imageUrl: e.preview.imageUrl,
      siteName: e.preview.siteName,
    }));
}

/**
 * Components are stored as bot-supplied JSON, so this is the boundary where that JSON stops being
 * arbitrary. A malformed tree renders as no components rather than throwing — a bot with a broken
 * component definition must not be able to make a message unreadable for everyone in the channel.
 */
export function parseComponents(raw: unknown): ActionRowDTO[] | null {
  if (!Array.isArray(raw)) return null;
  const rows: ActionRowDTO[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const components = (row as { components?: unknown }).components;
    if (!Array.isArray(components)) continue;
    const parsed: MessageComponentDTO[] = [];
    for (const c of components) {
      if (!c || typeof c !== "object") continue;
      const comp = c as Record<string, unknown>;
      if (comp.type === "button" && typeof comp.customId === "string" && typeof comp.label === "string") {
        const style = comp.style;
        parsed.push({
          type: "button",
          customId: comp.customId,
          label: comp.label,
          style:
            style === "primary" || style === "secondary" || style === "success" || style === "danger"
              ? style
              : "secondary",
          disabled: comp.disabled === true,
        });
      } else if (comp.type === "select" && typeof comp.customId === "string" && Array.isArray(comp.options)) {
        const options = comp.options
          .filter(
            (o): o is { value: string; label: string; description?: string } =>
              !!o &&
              typeof o === "object" &&
              typeof (o as { value?: unknown }).value === "string" &&
              typeof (o as { label?: unknown }).label === "string",
          )
          .map((o) => ({ value: o.value, label: o.label, description: o.description }));
        if (options.length === 0) continue;
        parsed.push({
          type: "select",
          customId: comp.customId,
          placeholder: typeof comp.placeholder === "string" ? comp.placeholder : undefined,
          disabled: comp.disabled === true,
          options,
        });
      }
    }
    if (parsed.length > 0) rows.push({ type: "row", components: parsed });
  }
  return rows.length > 0 ? rows : null;
}

type MessageLike = {
  id: bigint;
  channelId: string | null;
  dmConversationId: string | null;
  authorId: string | null;
  author: UserLike | null;
  content: string;
  editedAt: Date | null;
  pinned: boolean;
  replyToId: bigint | null;
  createdAt: Date;
  attachments: AttachmentLike[];
  reactions: ReactionLike[];
  webhookId: string | null;
  overrideUsername: string | null;
  overrideAvatarUrl: string | null;
  // All four optional so every existing caller that builds a MessageLike by hand (webhooks, the
  // search index, the data export) keeps compiling without having to include relations it does not
  // load. A message that did not load them serializes as "has none", which is correct.
  sticker?: StickerLike | null;
  poll?: PollLike | null;
  embeds?: EmbedLike[];
  componentsJson?: unknown;
  thread?: { id: string; name: string; archived: boolean; _count?: { messages: number } } | null;
};

export function serializeMessage(message: MessageLike, currentUserId: string | null = null): MessageDTO {
  return {
    id: message.id.toString(),
    channelId: message.channelId,
    dmConversationId: message.dmConversationId,
    authorId: message.authorId,
    author: message.author ? serializeUser(message.author) : null,
    content: message.content,
    editedAt: message.editedAt ? message.editedAt.toISOString() : null,
    pinned: message.pinned,
    replyToId: message.replyToId !== null ? message.replyToId.toString() : null,
    createdAt: message.createdAt.toISOString(),
    attachments: message.attachments.map(serializeAttachment),
    reactions: summarizeReactions(message.reactions, currentUserId),
    webhookId: message.webhookId,
    webhookUsername: message.overrideUsername,
    webhookAvatarUrl: message.overrideAvatarUrl,
    sticker: message.sticker ? serializeSticker(message.sticker) : null,
    poll: message.poll ? serializePoll(message.poll, currentUserId) : null,
    embeds: message.embeds ? serializeEmbeds(message.embeds) : [],
    components: parseComponents(message.componentsJson),
    thread: message.thread
      ? {
          id: message.thread.id,
          name: message.thread.name,
          archived: message.thread.archived,
          messageCount: message.thread._count?.messages ?? 0,
        }
      : null,
  };
}

type InviteLike = {
  code: string;
  serverId: string;
  creatorId: string;
  maxUses: number | null;
  uses: number;
  expiresAt: Date | null;
  createdAt: Date;
};

export function serializeInvite(invite: InviteLike): InviteDTO {
  return {
    code: invite.code,
    serverId: invite.serverId,
    creatorId: invite.creatorId,
    maxUses: invite.maxUses,
    uses: invite.uses,
    expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
    createdAt: invite.createdAt.toISOString(),
  };
}

type AuditLogEntryLike = {
  id: string;
  actorId: string | null;
  actionType: string;
  targetId: string | null;
  targetType: string | null;
  metadata: unknown;
  createdAt: Date;
};

export function serializeAuditLogEntry(entry: AuditLogEntryLike): AuditLogEntryDTO {
  return {
    id: entry.id,
    actorId: entry.actorId,
    actionType: entry.actionType,
    targetId: entry.targetId,
    targetType: entry.targetType,
    metadata: entry.metadata,
    createdAt: entry.createdAt.toISOString(),
  };
}

type DMConversationLike = {
  id: string;
  isGroup: boolean;
  name: string | null;
  participants: { userId: string; lastReadMessageId: bigint | null; user: UserLike }[];
};

export function serializeDMConversation(
  conversation: DMConversationLike,
  lastMessage: MessageLike | null,
  currentUserId: string | null = null,
): DMConversationDTO {
  return {
    id: conversation.id,
    isGroup: conversation.isGroup,
    name: conversation.name,
    participants: conversation.participants.map((p) => serializeUser(p.user)),
    lastMessage: lastMessage ? serializeMessage(lastMessage, currentUserId) : null,
    readStates: conversation.participants.map((p) => ({
      userId: p.userId,
      lastReadMessageId: p.lastReadMessageId?.toString() ?? null,
    })),
  };
}

type ApplicationLike = {
  id: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  createdAt: Date;
  redirectUris: string[];
  clientSecretHash: string | null;
};

export function serializeApplication(app: ApplicationLike, botUserId: string, botUsername: string): ApplicationDTO {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    iconUrl: app.iconUrl,
    createdAt: app.createdAt.toISOString(),
    botUserId,
    botUsername,
    redirectUris: app.redirectUris,
    hasClientSecret: !!app.clientSecretHash,
  };
}

type WebhookLike = {
  id: string;
  channelId: string;
  name: string;
  avatarUrl: string | null;
  creatorId: string;
  createdAt: Date;
};

export function serializeWebhook(webhook: WebhookLike): WebhookDTO {
  return {
    id: webhook.id,
    channelId: webhook.channelId,
    name: webhook.name,
    avatarUrl: webhook.avatarUrl,
    creatorId: webhook.creatorId,
    createdAt: webhook.createdAt.toISOString(),
  };
}

type FriendRequestLike = {
  id: string;
  requester: UserLike;
  addressee: UserLike;
  status: string;
  createdAt: Date;
};

export function serializeFriendRequest(request: FriendRequestLike): FriendRequestDTO {
  return {
    id: request.id,
    requester: serializeUser(request.requester),
    addressee: serializeUser(request.addressee),
    status: request.status as FriendRequestDTO["status"],
    createdAt: request.createdAt.toISOString(),
  };
}

type SessionLike = {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
  expiresAt: Date;
};

export function serializeSession(token: SessionLike, isCurrent: boolean): SessionDTO {
  return {
    id: token.id,
    userAgent: token.userAgent,
    ipAddress: token.ipAddress,
    createdAt: token.createdAt.toISOString(),
    expiresAt: token.expiresAt.toISOString(),
    isCurrent,
  };
}
