import Foundation
import Testing
@testable import LuminaKit

/// Frame-level tests for the hand-written Socket.IO parser.
///
/// Every string below is a real frame shape from Engine.IO v4 / Socket.IO v4. These are cheap and
/// they pin down the parts that are easy to get subtly wrong — particularly the heartbeat
/// direction, which produces a connection that works for exactly `pingTimeout` and then dies.
@Suite("Socket.IO framing")
struct SocketProtocolTests {

    @Test("The Engine.IO OPEN handshake yields the session and heartbeat timings")
    func openHandshake() {
        let frame = #"0{"sid":"abc123","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}"#
        guard case let .open(sid, interval, timeout) = EngineIOPacket.parse(frame) else {
            Issue.record("expected .open, got \(EngineIOPacket.parse(frame))")
            return
        }
        #expect(sid == "abc123")
        #expect(interval == 25000)
        #expect(timeout == 20000)
    }

    @Test("A bare 2 is the server's PING — the client must answer 3")
    func heartbeatDirection() {
        // v4 reversed this from v3. If the client instead *sends* 2 and expects 3, the server never
        // hears a pong, and closes the connection after pingTimeout — every time, on a healthy
        // network. The symptom looks like flaky wifi, not a protocol bug.
        guard case .ping = EngineIOPacket.parse("2") else {
            Issue.record("a bare 2 must parse as the server's PING")
            return
        }
        #expect(EngineIOOutbound.pong.text == "3")
    }

    @Test("CONNECT carries the auth payload the server's middleware reads")
    func connectCarriesAuth() {
        // authenticateSocket.ts reads socket.handshake.auth.accessToken; in the wire protocol that
        // is the object attached to the CONNECT packet.
        let frame = EngineIOOutbound.connect(auth: ["accessToken": "jwt-here"]).text
        #expect(frame.hasPrefix("40"))
        #expect(frame.contains("\"accessToken\""))
        #expect(frame.contains("jwt-here"))
    }

    @Test("An EVENT frame yields its name and a payload decodable by the normal models")
    func eventFrame() throws {
        let frame = #"42["message:create",{"id":"42","channelId":"c1","dmConversationId":null,"authorId":"u1","author":null,"content":"hello","editedAt":null,"pinned":false,"replyToId":null,"createdAt":"2026-08-11T20:11:38.191Z","attachments":[],"reactions":[],"webhookId":null,"webhookUsername":null,"webhookAvatarUrl":null}]"#
        guard case let .event(name, payload) = EngineIOPacket.parse(frame) else {
            Issue.record("expected .event")
            return
        }
        #expect(name == "message:create")

        // The point of re-serialising the payload: it decodes with the same Codable models and the
        // same date strategy as a REST response, rather than a second parallel parsing path.
        let event = RealtimeEvent(name: name, payload: payload)
        let message = try event.decode(Message.self)
        #expect(message.content == "hello")
        #expect(message.numericID == 42)
    }

    @Test("A CONNECT_ERROR surfaces the server's reason")
    func connectError() {
        let frame = #"44{"message":"Invalid or expired access token"}"#
        guard case let .connectError(message) = EngineIOPacket.parse(frame) else {
            Issue.record("expected .connectError")
            return
        }
        #expect(message.contains("expired"))
    }

    @Test("An unrecognised frame is ignored rather than fatal")
    func unknownFrameIsTolerated() {
        // A newer server may send packet types this build has never seen. Tearing down a working
        // connection over one is strictly worse than ignoring it.
        guard case .unhandled = EngineIOPacket.parse("9zzz") else {
            Issue.record("an unknown frame should parse as .unhandled")
            return
        }
    }

    @Test("Known event names match the shared catalogue")
    func eventNames() {
        #expect(ServerEvent.messageCreate.rawValue == "message:create")
        #expect(ServerEvent.appUpdateAvailable.rawValue == "app:update-available")
        #expect(ServerEvent(rawValue: "message:create") == .messageCreate)
        #expect(ServerEvent(rawValue: "invented:event") == nil)
    }
}
