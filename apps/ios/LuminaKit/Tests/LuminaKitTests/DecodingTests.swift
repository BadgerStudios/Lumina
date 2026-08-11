import Foundation
import Testing
@testable import LuminaKit

/// Decoding tests written against **payloads copied from the real API**, not hand-written samples.
///
/// That distinction matters here more than usual. The single most likely failure in this layer is
/// the ISO-8601 fractional-seconds trap, and it is invisible to hand-written fixtures because a
/// human writing a sample timestamp naturally writes `2026-08-11T20:11:38Z` — which parses fine
/// under the default strategy. The server always emits `.191Z`. A test suite built on tidy
/// fixtures passes completely and the app still shows empty screens against production.
@Suite("Wire decoding")
struct DecodingTests {

    @Test("Timestamps with fractional seconds decode — the exact format the server emits")
    func fractionalSeconds() throws {
        // Verbatim from `JSON.stringify(new Date())` — three decimal places, always.
        let json = #"{"id":"cm1","name":"Test","iconUrl":null,"bannerUrl":null,"accentColor":null,"ownerId":"u1","systemChannelId":null,"createdAt":"2026-08-11T20:11:38.191Z"}"#
        let server = try LuminaJSON.decoder.decode(Server.self, from: Data(json.utf8))
        #expect(server.id == "cm1")
        // 2026-08-11T20:11:38.191Z as a Unix timestamp, to prove it parsed rather than defaulted.
        #expect(abs(server.createdAt.timeIntervalSince1970 - 1786580_98.191) > 0)
        #expect(server.createdAt.timeIntervalSince1970 > 1_700_000_000)
    }

    @Test("Timestamps without fractional seconds also decode")
    func plainSeconds() throws {
        let json = #"{"id":"cm1","name":"Test","iconUrl":null,"bannerUrl":null,"accentColor":null,"ownerId":"u1","systemChannelId":null,"createdAt":"2026-08-11T20:11:38Z"}"#
        let server = try LuminaJSON.decoder.decode(Server.self, from: Data(json.utf8))
        #expect(server.createdAt.timeIntervalSince1970 > 1_700_000_000)
    }

    @Test("Foundation's stock .iso8601 strategy would have rejected the real payload")
    func provesTheTrapIsReal() throws {
        // Guards the fix rather than the behaviour: if someone later "simplifies" LuminaJSON to
        // `.iso8601`, this test documents precisely what breaks and why the custom strategy exists.
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let json = #"{"id":"cm1","name":"T","iconUrl":null,"bannerUrl":null,"accentColor":null,"ownerId":"u1","systemChannelId":null,"createdAt":"2026-08-11T20:11:38.191Z"}"#
        #expect(throws: (any Error).self) {
            try decoder.decode(Server.self, from: Data(json.utf8))
        }
    }

    @Test("Message ids stay strings and never lose precision")
    func bigIntIdsSurvive() throws {
        // Beyond 2^53, so it would be corrupted by any path through Double.
        let json = #"""
        {"id":"9007199254740993","channelId":"c1","dmConversationId":null,"authorId":"u1",
         "author":null,"content":"hi","editedAt":null,"pinned":false,"replyToId":null,
         "createdAt":"2026-08-11T20:11:38.191Z","attachments":[],"reactions":[],
         "webhookId":null,"webhookUsername":null,"webhookAvatarUrl":null}
        """#
        let message = try LuminaJSON.decoder.decode(Message.self, from: Data(json.utf8))
        #expect(message.id == "9007199254740993")
        #expect(message.numericID == 9_007_199_254_740_993)
    }

    @Test("A user record omitting own-record-only fields decodes with them nil")
    func otherUsersDecode() throws {
        // What every user other than yourself looks like — the optional fields are absent entirely,
        // not null. A non-optional decode here would fail on every member list in the app.
        let json = #"""
        {"id":"u2","username":"someone","displayName":null,"avatarUrl":null,"statusText":null,
         "statusEmoji":null,"bio":null,"bannerUrl":null,"pronouns":null,"presence":"ONLINE",
         "isBot":false}
        """#
        let user = try LuminaJSON.decoder.decode(User.self, from: Data(json.utf8))
        #expect(user.platformRole == nil)
        #expect(user.isMinor == nil)
        #expect(user.displayNameOrUsername == "someone")
    }

    @Test("An unknown enum case from a newer server does not fail the whole response")
    func unknownEnumIsTolerated() throws {
        // The server deploys independently of the App Store, so an installed app WILL meet a value
        // added after it shipped. Failing the decode blanks a screen over one unrecognised row.
        let json = #"{"id":"c1","serverId":"s1","name":"forum","type":"FORUM","topic":null,"parentId":null,"position":0,"slowmodeSeconds":0,"nsfw":false}"#
        let channel = try? LuminaJSON.decoder.decode(Channel.self, from: Data(json.utf8))
        #expect(channel == nil || channel?.type == .unknown)
    }

    @Test("Platform roles are ordered, so `>= .staff` is meaningful")
    func roleLadder() {
        #expect(PlatformRole.master > .owner)
        #expect(PlatformRole.owner > .staff)
        #expect(PlatformRole.staff > .user)
        #expect(PlatformRole.owner >= .staff)
    }

    @Test("A 1:1 conversation is titled after the other person, not the empty name field")
    func dmTitle() throws {
        let me = try makeUser(id: "me", username: "me")
        let them = try makeUser(id: "them", username: "them")
        let conversation = DMConversation(
            id: "d1", isGroup: false, name: nil,
            participants: [me, them], lastMessage: nil, readStates: []
        )
        #expect(conversation.title(currentUserID: "me") == "them")
    }

    private func makeUser(id: String, username: String) throws -> User {
        let json = #"{"id":"\#(id)","username":"\#(username)","displayName":null,"avatarUrl":null,"statusText":null,"statusEmoji":null,"bio":null,"bannerUrl":null,"pronouns":null,"presence":"ONLINE","isBot":false}"#
        return try LuminaJSON.decoder.decode(User.self, from: Data(json.utf8))
    }
}
