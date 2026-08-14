// Shared DTO shapes exchanged over REST/Socket.IO. BigInt fields (message ids, permission
// bitfields) are always serialized as decimal strings over the wire — plain JSON.stringify
// can't handle bigint, so both backend responses and frontend parsing treat these as strings.

export type PresenceStatus = "ONLINE" | "IDLE" | "DND" | "OFFLINE";

/** Platform-wide authority ladder, strictly ordered — each rank implies everything below it.
 * MASTER is a single account and is assignable only from the server's MASTER_EMAIL env var. */
export type PlatformRole = "USER" | "STAFF" | "OWNER" | "MASTER";

/** Coarse age bands collected at signup. Only the minor/adult distinction is acted on. */
export type AgeBracket = "UNDER_18" | "AGE_18_24" | "AGE_25_34" | "AGE_35_49" | "AGE_50_PLUS";
/** THREAD exists in the enum because a thread IS a Channel row, but it never appears in a
 * ChannelDTO the client receives — the channel-list route filters it out (threads are fetched
 * through their parent, as ThreadDTO). It is here so serializeChannel's type stays honest. */
export type ChannelType = "TEXT" | "CATEGORY" | "VOICE" | "THREAD";

export interface UserDTO {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  statusText: string | null;
  statusEmoji: string | null;
  bio: string | null;
  bannerUrl: string | null;
  pronouns: string | null;
  presence: PresenceStatus;
  isBot: boolean;
  // Only populated when this UserDTO represents the logged-in user's own account (see
  // serializeMe in backend lib/serialize.ts) — undefined on every other user's DTO.
  allowDmsFromNonFriends?: boolean;
  allowFriendRequests?: boolean;
  // Platform authority, own-record only. A UI hint for showing the staff/owner nav entries — never
  // the access control itself, which lives in requireStaff/requireOwner on every privileged route.
  platformRole?: PlatformRole;
  // Own-record only. ageVerified=false means the account predates age collection and must answer
  // before it can use adult-only surfaces; until then it is treated as a minor.
  ageVerified?: boolean;
  isMinor?: boolean;
  /** Own-record only. Presentational — drives the "confirm your email" banner and gates nothing. */
  emailVerified?: boolean;
  /** A first-party Lumina account. Rendered as a badge — deliberately a server-set flag rather
   * than anything a user can put in their own profile, since the whole point is that it cannot be
   * copied by someone claiming to be staff. */
  isOfficial?: boolean;
}

/** A dev-portal app a user owns, with exactly one bot User (see backend schema.prisma
 * User.applicationId) — matches Discord's bot model. Also doubles as an OAuth2 client (see
 * modules/oauth2/): `id` IS the client_id, redirectUris is the allowlist for the
 * authorization-code grant, hasClientSecret tells the Dev Portal whether to show "Generate" or
 * "Regenerate" without ever exposing the hash. */
export interface ApplicationDTO {
  id: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  createdAt: string;
  botUserId: string;
  botUsername: string;
  redirectUris: string[];
  hasClientSecret: boolean;
  /// Privileged gateway intents (Discord-dev-portal parity): enforced in the compat gateway
  /// (content blanking) and the compat members listing. OFF by default.
  intents: { messageContent: boolean; serverMembers: boolean };
}

/** Returned exactly once, from POST /api/applications and POST /api/applications/:id/regenerate
 * — the raw bot token is never retrievable again after this response (only its hash is
 * persisted), same "show once" handling as everything else touching secrets in this app. */
export interface ApplicationWithTokenDTO extends ApplicationDTO {
  botToken: string;
}

/** Returned exactly once, from POST /api/applications/:id/oauth/regenerate-secret — same
 * "show once" handling as ApplicationWithTokenDTO's botToken. */
export interface ApplicationWithClientSecretDTO extends ApplicationDTO {
  clientSecret: string;
}

/** Public-safe info about an app requesting OAuth2 authorization, shown on the consent screen —
 * deliberately NOT the full ApplicationDTO (no botUserId/hasClientSecret leak to an
 * unauthenticated-w.r.t.-this-app consent page). */
export interface OAuthAuthorizeInfoDTO {
  clientId: string;
  name: string;
  iconUrl: string | null;
  scope: string;
  redirectUri: string;
}

/** A channel-scoped incoming webhook (see modules/webhooks) — Discord-style: external services
 * POST to its token-bearing URL, no user session required, and a message appears with the
 * webhook's own name/avatar rather than any real user's. */
export interface WebhookDTO {
  id: string;
  channelId: string;
  name: string;
  avatarUrl: string | null;
  creatorId: string;
  createdAt: string;
}

/** Returned exactly once, from POST /api/channels/:id/webhooks — same "show once" token
 * handling as ApplicationWithTokenDTO/refresh tokens. */
export interface WebhookWithTokenDTO extends WebhookDTO {
  token: string;
}

export interface RoleDTO {
  id: string;
  serverId: string;
  name: string;
  color: number | null;
  permissions: string; // bigint as string
  position: number;
  isDefault: boolean;
  mentionable: boolean;
}

export interface MemberDTO {
  userId: string;
  serverId: string;
  nickname: string | null;
  mutedUntil: string | null;
  joinedAt: string;
  user: UserDTO;
  roleIds: string[];
}

export interface ChannelDTO {
  id: string;
  serverId: string;
  name: string;
  type: ChannelType;
  topic: string | null;
  parentId: string | null;
  position: number;
  slowmodeSeconds: number;
  nsfw: boolean;
}

/**
 * A thread, as the client sees it.
 *
 * Deliberately NOT a ChannelDTO even though a thread is a Channel row server-side. The two are
 * used in different places for different things — a thread carries an archive state, a member
 * count and a joined flag, and carries none of a channel's topic/slowmode/nsfw/position — and
 * widening ChannelDTO with six always-null fields would push "is this actually a thread?" checks
 * into every component that renders a channel.
 */
export interface ThreadDTO {
  id: string;
  serverId: string;
  name: string;
  parentId: string | null;
  originMessageId: string | null;
  archived: boolean;
  archivedAt: string | null;
  autoArchiveMinutes: number;
  lastActivityAt: string | null;
  createdAt: string;
  messageCount: number;
  memberCount: number;
  joined: boolean;
}

/** A minor's own view of their supervision state. */
export interface MinorStateDTO {
  isMinor: boolean;
  locked: boolean;
  pairingCode: string | null;
  status?: "PENDING" | "ACTIVE" | "REVOKED" | null;
  parent: { id: string; username: string; displayName: string | null; avatarUrl: string | null } | null;
}

export interface LinkedChildDTO {
  linkId: string;
  acceptedAt: string | null;
  child: { id: string; username: string; displayName: string | null; avatarUrl: string | null; presence: PresenceStatus };
  approvedContacts: {
    id: string;
    note: string | null;
    user: { id: string; username: string; displayName: string | null; avatarUrl: string | null };
  }[];
}

/** A person the child has exchanged DMs with. `isAdult` is the field a parent actually scans for. */
export interface ChildContactDTO {
  user: UserDTO;
  isAdult: boolean;
  conversationId: string;
}

export type VerificationLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH";
export type ExplicitContentFilter = "DISABLED" | "MEMBERS_WITHOUT_ROLES" | "ALL_MEMBERS";
export type NotificationLevel = "ALL" | "MENTIONS" | "NONE";

export interface ServerDTO {
  id: string;
  name: string;
  iconUrl: string | null;
  bannerUrl: string | null;
  accentColor: number | null;
  ownerId: string;
  systemChannelId: string | null;
  createdAt: string;
  description: string | null;
  vanityCode: string | null;
  verificationLevel: VerificationLevel;
  explicitContentFilter: ExplicitContentFilter;
  defaultNotificationLevel: NotificationLevel;
  afkChannelId: string | null;
  afkTimeoutSec: number;
  sysJoinMessages: boolean;
  sysLeaveMessages: boolean;
  sysBoostMessages: boolean;
  rulesChannelId: string | null;
  discoverable: boolean;
  minecraftHost: string | null;
}

export interface AttachmentDTO {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  width: number | null;
  height: number | null;
}

export interface ReactionSummaryDTO {
  emoji: string;
  count: number;
  reactedByMe: boolean;
}

export interface MessageDTO {
  id: string; // bigint as string
  channelId: string | null;
  dmConversationId: string | null;
  authorId: string | null;
  author: UserDTO | null;
  content: string;
  editedAt: string | null;
  pinned: boolean;
  replyToId: string | null;
  createdAt: string;
  attachments: AttachmentDTO[];
  reactions: ReactionSummaryDTO[];
  // Set only for a Discord-style incoming-webhook post (see modules/webhooks): author/authorId
  // are null in that case — there's no real User behind it, unlike a bot (which IS a real User
  // row with isBot: true) — so the display identity travels here instead of being faked onto a
  // synthetic UserDTO.
  webhookId: string | null;
  webhookUsername: string | null;
  webhookAvatarUrl: string | null;
  // A sticker or a poll IS the message body rather than something attached to it, which is why
  // these are top-level and not entries in `attachments`. Both stay non-null on a message whose
  // sticker/poll was later deleted only if the row still exists — the FKs are SetNull, so a deleted
  // sticker leaves `sticker: null` with the message itself intact.
  sticker: StickerDTO | null;
  poll: PollDTO | null;
  /** Unfurled links, in the order they appeared in the text. Empty until the worker fetches them. */
  embeds: LinkPreviewDTO[];
  /** Buttons/selects a bot attached to this message. Null for every human-sent message. */
  components: ActionRowDTO[] | null;
  /** Set when this message has spawned a thread. Minimal on purpose — enough to render the
   * "N replies" affordance without a second request, and nothing more; opening the thread fetches
   * the full ThreadDTO. */
  thread: { id: string; name: string; messageCount: number; archived: boolean } | null;
}

export interface StickerDTO {
  id: string;
  serverId: string;
  name: string;
  description: string | null;
  imageUrl: string;
  animated: boolean;
  createdAt: string;
}

export interface PollOptionDTO {
  id: string;
  label: string;
  position: number;
  votes: number;
  /**
   * Whether the *requesting* user picked this option. Necessarily false on the realtime broadcast,
   * which is serialized once for the whole room — the client patches its own flag from the voterId
   * on POLL_VOTE_UPDATE, exactly as it already does for reactions.
   */
  votedByMe: boolean;
}

export interface PollDTO {
  id: string;
  question: string;
  allowMultiple: boolean;
  expiresAt: string | null;
  /** Derived server-side from expiresAt so a client with a wrong clock cannot vote in a shut poll. */
  closed: boolean;
  totalVotes: number;
  options: PollOptionDTO[];
}

export interface LinkPreviewDTO {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

export interface SoundboardSoundDTO {
  id: string;
  serverId: string;
  name: string;
  audioUrl: string;
  emoji: string | null;
  durationMs: number;
  createdAt: string;
}

/**
 * Interactive components, shaped like Discord's so a bot written against their docs is a small
 * rewrite rather than a redesign. Rows exist because buttons lay out horizontally and a client
 * needs to know where to wrap.
 */
export interface ActionRowDTO {
  type: "row";
  components: MessageComponentDTO[];
}

export type MessageComponentDTO = ButtonComponentDTO | SelectComponentDTO;

export interface ButtonComponentDTO {
  type: "button";
  customId: string;
  label: string;
  style: "primary" | "secondary" | "success" | "danger";
  disabled?: boolean;
}

export interface SelectComponentDTO {
  type: "select";
  customId: string;
  placeholder?: string;
  disabled?: boolean;
  options: Array<{ value: string; label: string; description?: string }>;
}

export interface SlashCommandDTO {
  id: string;
  applicationId: string;
  name: string;
  description: string;
  options: SlashCommandOptionDTO[];
}

export interface SlashCommandOptionDTO {
  name: string;
  description: string;
  type: "string" | "integer" | "boolean" | "user" | "channel";
  required?: boolean;
  choices?: Array<{ name: string; value: string | number }>;
}

/** What a bot receives on ClientEvents-side INTERACTION_CREATE. */
export interface InteractionDTO {
  id: string;
  type: "command" | "component";
  token: string;
  userId: string;
  channelId: string | null;
  dmConversationId: string | null;
  serverId: string | null;
  commandName: string | null;
  options: Record<string, string | number | boolean> | null;
  customId: string | null;
  messageId: string | null;
  createdAt: string;
}

export interface ServerTemplateDTO {
  code: string;
  name: string;
  description: string | null;
  creatorId: string | null;
  uses: number;
  createdAt: string;
  /** Enough to render a preview without handing the whole snapshot to the client. */
  summary: {
    categories: number;
    textChannels: number;
    voiceChannels: number;
    roles: number;
  };
}

export interface InviteDTO {
  code: string;
  serverId: string;
  creatorId: string;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface AuditLogEntryDTO {
  id: string;
  // Null once the actor's User row has been deleted (currently only possible for a deleted
  // bot — see backend schema.prisma AuditLogEntry.actorId — humans never actually get their
  // User row deleted, only their server Membership).
  actorId: string | null;
  actionType: string;
  targetId: string | null;
  targetType: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface DMConversationDTO {
  id: string;
  isGroup: boolean;
  name: string | null;
  participants: UserDTO[];
  lastMessage: MessageDTO | null;
  // Per-participant read position (DMParticipant.lastReadMessageId) — lets the UI show a "seen"
  // indicator. null means that participant has never marked the conversation read.
  readStates: Array<{ userId: string; lastReadMessageId: string | null }>;
}

/** Per-channel unread summary for the current user, backing the Signal panel. Only channels
 * with unreadCount > 0 are returned by GET /api/servers/:id/unread. */
export interface UnreadDTO {
  channelId: string;
  unreadCount: number;
}

/** One @mention addressed to the current user (directly, via a role, or @everyone), backing
 * the mobile Activity feed. Returned newest-first by GET /api/users/me/mentions. */
export interface MentionFeedItemDTO {
  id: string;
  message: MessageDTO;
  serverId: string;
  serverName: string;
  channelId: string;
  channelName: string;
  createdAt: string;
}

export type FriendRequestStatus = "PENDING" | "ACCEPTED" | "DECLINED" | "BLOCKED";

/** A row from FriendRequest, in whichever direction it was sent — GET /api/friends/requests
 * returns { incoming, outgoing } of these, both filtered to PENDING. */
export interface FriendRequestDTO {
  id: string;
  requester: UserDTO;
  addressee: UserDTO;
  status: FriendRequestStatus;
  createdAt: string;
}

/** An accepted friendship, from the current user's point of view — `user` is always the OTHER
 * person, never the caller themselves. */
export interface FriendDTO {
  user: UserDTO;
  since: string;
}

/** Why a suggested person appeared. Deliberately a small closed set: the reason is the only thing
 * the server is permitted to say about how a suggestion was derived, and every value here asserts
 * a fact the caller could already obtain from an existing, permission-checked endpoint. Signals
 * that rank but may never be stated (same-channel co-activity, signup country) have no code here
 * on purpose. */
export type SuggestionReasonCode =
  | "DIRECT_DM"
  | "MUTUAL_FRIENDS"
  | "SHARED_GROUP_DM"
  | "SHARED_SERVER"
  | "NEW_TO_LUMINA";

/**
 * One "People you may know" entry.
 *
 * Carries no score and no signal breakdown. `reason` is composed server-side so the privacy rule
 * lives in exactly one function, and mutual friends are counted but never named — no endpoint on
 * this platform exposes another user's friend list, so naming one would invent a disclosure
 * channel the rest of the app deliberately doesn't have.
 */
export interface FriendSuggestionDTO {
  user: UserDTO;
  reasonCode: SuggestionReasonCode;
  reason: string;
  /** Present only when reasonCode is MUTUAL_FRIENDS. */
  mutualFriendCount?: number;
}

export interface FriendSuggestionsResponse {
  suggestions: FriendSuggestionDTO[];
  /** Set when the caller can't be served at all. AGE_UNVERIFIED means no age on record — which
   * already blocks the whole app behind the age gate, so this exists to keep the API
   * self-describing rather than because any UI renders it. */
  gated?: "AGE_UNVERIFIED";
}

/** One connection to a voice channel — socketId (not just userId) matters because the mesh
 * WebRTC signaling relay (realtime/handlers/voice.ts) addresses peer connections per-socket:
 * the same user open in two tabs would be two separate participants, each with their own
 * peer connections to everyone else in the room. Never persisted — purely a live room roster. */
export interface VoiceParticipantDTO {
  userId: string;
  socketId: string;
  user: UserDTO;
  /** What this participant is broadcasting into the call right now — "screen" renders the red
   * LIVE treatment, "camera" the plain video indicator. Carried on the server-wide roster so
   * people OUTSIDE the call can see someone has gone live without joining first. */
  streaming?: "screen" | "camera" | null;
}

/** One RefreshToken row, i.e. one logged-in device/browser (see UserSettingsModal.tsx's
 * session-management section). `isCurrent` is only reliably known for the web client (the
 * refresh token rides an httpOnly cookie scoped to /api/auth, so the session-listing route can
 * compare it) — mobile/desktop clients get `isCurrent: false` on every row rather than a guess. */
export interface SessionDTO {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export type VideoStatus =
  | "PROCESSING"
  | "PENDING_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "REMOVED"
  | "FAILED";

/** One short-form video in the global "For You" feed. Unlike every other content DTO here this
 * carries no serverId/channelId — the feed is cross-server by design.
 *
 * Two serializations exist behind this one shape, and the difference is a trust boundary, not a
 * convenience: the PUBLIC form (feed responses) is only ever produced for APPROVED videos and omits
 * the moderation fields entirely, while the OWNER/STAFF form (own uploads, staff queue) includes
 * `status`, `rejectionReason` and `failureReason` so an uploader can see why their video was held
 * or refused. Never widen the public one to include moderation state. */
export interface VideoDTO {
  id: string;
  author: UserDTO | null;
  caption: string | null;
  /** Range-capable media URLs; null while the video is still PROCESSING or if it FAILED. */
  playbackUrl: string | null;
  thumbnailUrl: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  likeCount: number;
  viewCount: number;
  commentCount: number;
  /** Whether the requesting user has liked this. Absent on staff-queue responses. */
  likedByMe?: boolean;
  /** Tag names, already normalised (lowercase, no leading #). Empty when the video has none. */
  tags: string[];
  createdAt: string;
  /** Whether this video's uploader allows others to remix it. Presentation only — both are
   * re-checked server-side when a derivative is actually created. */
  allowStitch: boolean;
  allowDuet: boolean;
  /** Set when THIS video was made from another one. */
  derivativeType?: "STITCH" | "DUET" | null;
  /** Attribution for a derivative: who it was made from. Deliberately a trimmed shape rather than a
   * nested VideoDTO — a card needs the credit and a way to open the original, not a second full
   * video record (which would recurse, since that video may itself carry a source). */
  sourceVideo?: {
    id: string;
    author: UserDTO | null;
    caption: string | null;
    /** Null once the original has been deleted; the derivative survives, the link doesn't. */
    thumbnailUrl: string | null;
  } | null;
  /** How many stitches/duets have been made from this video. */
  derivativeCount: number;
  /** Present only on a promoted card: the campaign id to label as Sponsored and beacon against.
   * Absent on every organic video, so the label can never be shown by accident. */
  sponsoredBy?: string;
  // Moderation fields — owner's-own-uploads and staff responses only, never on the public feed.
  status?: VideoStatus;
  rejectionReason?: string | null;
  failureReason?: string | null;
}
