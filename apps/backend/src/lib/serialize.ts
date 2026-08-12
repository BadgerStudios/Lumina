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
