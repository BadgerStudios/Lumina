import Foundation

/// Wire models, mirroring `packages/shared/src/types.ts`.
///
/// ## The one rule that governs every id in this file
///
/// The backend's message ids and permission bitfields are **BigInt in Postgres and decimal strings
/// on the wire**. `JSON.stringify` cannot encode a JS `bigint` at all, so the server serialises them
/// as strings and the TypeScript client parses them back. That is not a quirk to normalise away
/// here: decoding `MessageDTO.id` as `Int64` throws `typeMismatch` on the very first message, and a
/// permission bitfield beyond 2^53 would silently lose precision if routed through `Double`.
///
/// So every such field stays a `String`, exactly as it arrives, and typed accessors are offered
/// where arithmetic is genuinely needed (`Message.numericID` for ordering, `Permissions` for the
/// bitfield). The wire shape is preserved; interpretation is opt-in.
///
/// ## Optionality means something specific
///
/// Fields the TypeScript declares with `?` are populated **only on the logged-in user's own
/// record** (see `serializeMe` in the backend). They are not "sometimes missing" — they are absent
/// for every other user by design, and a view that shows `platformRole` for anyone else is reading
/// something that will always be nil.

// MARK: - Enumerations
//
// Every one of these is `RawRepresentable` by String and decoded through `decodeLenient`, which
// falls back to a `.unknown` case instead of throwing. That matters more than it looks: the server
// is deployed independently of the App Store, so a new ChannelType or VideoStatus WILL reach an
// older installed app. A strict enum turns that into a decode failure that takes down the whole
// screen, rather than one row rendering as unrecognised.

public enum PresenceStatus: String, Codable, Sendable, CaseIterable {
    case online = "ONLINE", idle = "IDLE", dnd = "DND", offline = "OFFLINE"
}

public enum PlatformRole: String, Codable, Sendable, CaseIterable, Comparable {
    case user = "USER", staff = "STAFF", owner = "OWNER", master = "MASTER"

    /// The ladder is strictly ordered and each rank implies everything below it, so comparison is
    /// the natural way to ask "is this at least staff" without a switch at every call site.
    private var rank: Int {
        switch self {
        case .user: 0
        case .staff: 1
        case .owner: 2
        case .master: 3
        }
    }

    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rank < rhs.rank }
}

public enum AgeBracket: String, Codable, Sendable, CaseIterable {
    case under18 = "UNDER_18"
    case age18to24 = "AGE_18_24"
    case age25to34 = "AGE_25_34"
    case age35to49 = "AGE_35_49"
    case age50Plus = "AGE_50_PLUS"
}

public enum ChannelType: String, Codable, Sendable {
    case text = "TEXT", category = "CATEGORY", voice = "VOICE"
    case unknown = "__unknown"
}

public enum FriendRequestStatus: String, Codable, Sendable {
    case pending = "PENDING", accepted = "ACCEPTED", declined = "DECLINED", blocked = "BLOCKED"
    case unknown = "__unknown"
}

public enum VideoStatus: String, Codable, Sendable {
    case processing = "PROCESSING"
    case pendingReview = "PENDING_REVIEW"
    case approved = "APPROVED"
    case rejected = "REJECTED"
    case removed = "REMOVED"
    case failed = "FAILED"
    case unknown = "__unknown"
}

// MARK: - User

public struct User: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let username: String
    public let displayName: String?
    public let avatarURL: String?
    public let statusText: String?
    public let statusEmoji: String?
    public let bio: String?
    public let bannerURL: String?
    public let pronouns: String?
    public let presence: PresenceStatus
    public let isBot: Bool

    // ---- own-record only; nil for everyone else ----
    public let allowDMsFromNonFriends: Bool?
    public let allowFriendRequests: Bool?
    /// A UI hint for showing staff/owner entries — **never** the access control itself, which lives
    /// in `requireStaff`/`requireOwner` on every privileged route. A client that treats this as
    /// authorisation is trusting a value it received over the network.
    public let platformRole: PlatformRole?
    public let ageVerified: Bool?
    public let isMinor: Bool?

    /// A first-party Lumina account. Server-set precisely so it cannot be copied by someone
    /// claiming to be staff — the badge is the only part of an "official" identity that means
    /// anything, since anyone can set the same name, bio and picture.
    public let isOfficial: Bool?

    /// What to actually put on screen. The server permits a null display name, and falling back at
    /// each call site is how half the UI ends up showing a raw username and the other half a blank.
    public var displayNameOrUsername: String { displayName ?? username }

    enum CodingKeys: String, CodingKey {
        case id, username, displayName
        case avatarURL = "avatarUrl"
        case statusText, statusEmoji, bio
        case bannerURL = "bannerUrl"
        case pronouns, presence, isBot
        case allowDMsFromNonFriends = "allowDmsFromNonFriends"
        case allowFriendRequests, platformRole, ageVerified, isMinor, isOfficial
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        username = try c.decode(String.self, forKey: .username)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
        avatarURL = try c.decodeIfPresent(String.self, forKey: .avatarURL)
        statusText = try c.decodeIfPresent(String.self, forKey: .statusText)
        statusEmoji = try c.decodeIfPresent(String.self, forKey: .statusEmoji)
        bio = try c.decodeIfPresent(String.self, forKey: .bio)
        bannerURL = try c.decodeIfPresent(String.self, forKey: .bannerURL)
        pronouns = try c.decodeIfPresent(String.self, forKey: .pronouns)
        presence = try c.decodeIfPresent(PresenceStatus.self, forKey: .presence) ?? .offline
        isBot = try c.decodeIfPresent(Bool.self, forKey: .isBot) ?? false
        allowDMsFromNonFriends = try c.decodeIfPresent(Bool.self, forKey: .allowDMsFromNonFriends)
        allowFriendRequests = try c.decodeIfPresent(Bool.self, forKey: .allowFriendRequests)
        platformRole = try c.decodeIfPresent(PlatformRole.self, forKey: .platformRole)
        ageVerified = try c.decodeIfPresent(Bool.self, forKey: .ageVerified)
        isMinor = try c.decodeIfPresent(Bool.self, forKey: .isMinor)
        isOfficial = try c.decodeIfPresent(Bool.self, forKey: .isOfficial)
    }
}

// MARK: - Servers, channels, roles

public struct Role: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let serverId: String
    public let name: String
    public let color: Int?
    /// Bitfield, decimal string on the wire. See `Permissions`.
    public let permissions: String
    public let position: Int
    public let isDefault: Bool
    public let mentionable: Bool
}

public struct Member: Codable, Sendable, Hashable, Identifiable {
    public let userId: String
    public let serverId: String
    public let nickname: String?
    public let mutedUntil: Date?
    public let joinedAt: Date
    public let user: User
    public let roleIds: [String]

    public var id: String { "\(serverId):\(userId)" }
    public var displayName: String { nickname ?? user.displayNameOrUsername }

    /// Whether a timeout is currently in force. Computed from the timestamp rather than stored as a
    /// flag, so it expires on its own — the server applies exactly the same rule.
    public var isTimedOut: Bool {
        guard let mutedUntil else { return false }
        return mutedUntil > Date()
    }
}

public struct Channel: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let serverId: String
    public let name: String
    public let type: ChannelType
    public let topic: String?
    public let parentId: String?
    public let position: Int
    public let slowmodeSeconds: Int
    public let nsfw: Bool
}

public struct Server: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let iconURL: String?
    public let bannerURL: String?
    public let accentColor: Int?
    public let ownerId: String
    public let systemChannelId: String?
    public let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id, name
        case iconURL = "iconUrl"
        case bannerURL = "bannerUrl"
        case accentColor, ownerId, systemChannelId, createdAt
    }
}

// MARK: - Messages

public struct Attachment: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let fileName: String
    public let mimeType: String
    public let sizeBytes: Int
    public let url: String
    public let width: Int?
    public let height: Int?

    public var isImage: Bool { mimeType.hasPrefix("image/") }
    public var isVideo: Bool { mimeType.hasPrefix("video/") }
    public var isAudio: Bool { mimeType.hasPrefix("audio/") }
}

public struct ReactionSummary: Codable, Sendable, Hashable {
    public let emoji: String
    public let count: Int
    public let reactedByMe: Bool
}

public struct Message: Codable, Sendable, Identifiable, Hashable {
    /// BigInt as a decimal string — never decode this as an integer. See the file header.
    public let id: String
    public let channelId: String?
    public let dmConversationId: String?
    public let authorId: String?
    public let author: User?
    public let content: String
    public let editedAt: Date?
    public let pinned: Bool
    public let replyToId: String?
    public let createdAt: Date
    public let attachments: [Attachment]
    public let reactions: [ReactionSummary]

    // Set only for a webhook post. There is no real User behind one — unlike a bot, which IS a real
    // User row with isBot true — so the display identity travels in these fields rather than being
    // faked onto a synthetic User.
    public let webhookId: String?
    public let webhookUsername: String?
    public let webhookAvatarURL: String?

    /// Ids are a monotonic sequence, so this is the correct sort key — and cursor pagination on the
    /// server uses `id < cursor` for exactly the same reason. Sorting by `createdAt` instead would
    /// tie for messages written inside the same millisecond and reorder them between refreshes.
    public var numericID: Int64 { Int64(id) ?? 0 }

    /// Name to render, accounting for webhooks having no author at all.
    public var displayAuthorName: String {
        if let webhookUsername { return webhookUsername }
        return author?.displayNameOrUsername ?? "Deleted user"
    }

    enum CodingKeys: String, CodingKey {
        case id, channelId, dmConversationId, authorId, author, content, editedAt, pinned
        case replyToId, createdAt, attachments, reactions, webhookId, webhookUsername
        case webhookAvatarURL = "webhookAvatarUrl"
    }
}

// MARK: - DMs, friends

public struct DMReadState: Codable, Sendable, Hashable {
    public let userId: String
    public let lastReadMessageId: String?
}

public struct DMConversation: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let isGroup: Bool
    public let name: String?
    public let participants: [User]
    public let lastMessage: Message?
    public let readStates: [DMReadState]

    /// A 1:1 conversation has no name of its own — it is named after the other person. Taking
    /// "the first participant that isn't me" requires knowing who "me" is, which is why this is a
    /// function rather than a property.
    public func title(currentUserID: String) -> String {
        if let name, !name.isEmpty { return name }
        let others = participants.filter { $0.id != currentUserID }
        if others.isEmpty { return "Just you" }
        return others.map(\.displayNameOrUsername).joined(separator: ", ")
    }
}

public struct FriendRequest: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let requester: User
    public let addressee: User
    public let status: FriendRequestStatus
    public let createdAt: Date
}

public struct Friend: Codable, Sendable, Identifiable, Hashable {
    public let user: User
    public let since: Date?
    public var id: String { user.id }
}

// MARK: - Video feed

public struct Video: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let authorId: String?
    public let author: User?
    public let caption: String?
    public let status: VideoStatus
    public let playbackURL: String?
    public let thumbnailURL: String?
    public let durationMs: Int?
    public let width: Int?
    public let height: Int?
    public let likeCount: Int
    public let viewCount: Int
    public let commentCount: Int
    public let likedByMe: Bool?
    public let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id, authorId, author, caption, status
        case playbackURL = "playbackUrl"
        case thumbnailURL = "thumbnailUrl"
        case durationMs, width, height, likeCount, viewCount, commentCount, likedByMe, createdAt
    }
}

// MARK: - Sessions

public struct Session: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let userAgent: String?
    public let ipAddress: String?
    public let createdAt: Date
    public let expiresAt: Date
    public let current: Bool?
}

// MARK: - Auth envelopes

public struct AuthResponse: Codable, Sendable {
    public let user: User
    public let accessToken: String
    /// Present on mobile only. A Capacitor WebView and a native app both lack a usable cookie jar
    /// for the API's origin, so the server returns the refresh token in the body instead of an
    /// httpOnly cookie when the client identifies as mobile.
    public let refreshToken: String?
}

public struct VersionManifest: Codable, Sendable {
    public let androidVersionCode: Int
    public let android: ReleaseInfo?
    public let owner: ReleaseInfo?

    public struct ReleaseInfo: Codable, Sendable {
        public let versionCode: Int
        public let url: String
        public let sizeBytes: Int
        public let sha256: String
    }
}

// MARK: - Lenient enum decoding

extension KeyedDecodingContainer {
    /// Decodes a string-backed enum, falling back to `fallback` when the server sends a case this
    /// build has never heard of.
    ///
    /// The server ships independently of the App Store, so an older installed app WILL eventually
    /// receive a value added after it was built. Throwing there fails the whole response and blanks
    /// a screen over one unrecognised row, which is a much worse outcome than rendering that row as
    /// unknown.
    func decodeLenient<T: RawRepresentable & Decodable>(
        _ type: T.Type, forKey key: Key, fallback: T
    ) throws -> T where T.RawValue == String {
        guard let raw = try decodeIfPresent(String.self, forKey: key) else { return fallback }
        return T(rawValue: raw) ?? fallback
    }
}
