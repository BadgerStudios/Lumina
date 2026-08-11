import Foundation
import Testing
@testable import LuminaKit

/// Parser tests against frames **captured verbatim from the live Lumina server**.
///
/// ## Why these exist separately from SocketProtocolTests
///
/// Those tests use frames written from the specification, which proves the parser handles what I
/// believe the protocol to be. These are the bytes the server actually sent on 2026-08-11, recorded
/// off a real authenticated session — they prove the parser handles what the server genuinely does,
/// which is a different and stronger claim.
///
/// ## Why the transport is not tested here
///
/// It cannot be, on this machine. `URLSessionWebSocketTask` *compiles* on Linux but fails at runtime
/// with "WebSockets not supported by libcurl" — swift-corelibs-foundation's URLSession is
/// libcurl-backed and this build lacks WebSocket support. Compiling is not the same as working, and
/// the earlier assumption that it was is exactly the sort of thing worth writing down.
///
/// On iOS and macOS the transport is Apple's own native implementation and works normally, so what
/// remains unverified is a few lines of standard `webSocketTask(with:)` / `receive()` plumbing —
/// while everything genuinely likely to be wrong (frame parsing, handshake ordering, heartbeat
/// direction, event decoding) is pinned here against real data.
@Suite("Captured live frames")
struct CapturedFrameTests {

    /// The complete opening exchange of a real session, in order.
    static let captured = [
        #"0{"sid":"KHmiSMaRjWdVJqabAAAE","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}"#,
        #"40{"sid":"uDpInn6Sk7NRRuMYAAAF"}"#,
        #"42["presence:update",{"userId":"cmsp503a0000pnt01j3igfdue","presence":"ONLINE"}]"#,
        #"42["app:update-available",{"at":"2026-08-11T20:52:52.533Z"}]"#,
    ]

    @Test("The real handshake parses, in the order the server sends it")
    func realHandshakeSequence() {
        var states: [String] = []
        for frame in Self.captured {
            switch EngineIOPacket.parse(frame) {
            case let .open(sid, interval, timeout):
                states.append("open")
                #expect(sid == "KHmiSMaRjWdVJqabAAAE")
                #expect(interval == 25000)
                #expect(timeout == 20000)
            case .connected:
                states.append("connected")
            case let .event(name, _):
                states.append("event:\(name)")
            default:
                states.append("other")
            }
        }
        #expect(states == ["open", "connected", "event:presence:update", "event:app:update-available"])
    }

    @Test("A real presence event decodes into a usable value")
    func presencePayload() throws {
        guard case let .event(name, payload) = EngineIOPacket.parse(Self.captured[2]) else {
            Issue.record("expected an event")
            return
        }
        #expect(name == ServerEvent.presenceUpdate.rawValue)

        struct PresencePayload: Decodable { let userId: String; let presence: PresenceStatus }
        let decoded = try RealtimeEvent(name: name, payload: payload).decode(PresencePayload.self)
        #expect(decoded.userId == "cmsp503a0000pnt01j3igfdue")
        #expect(decoded.presence == .online)
    }

    @Test("The real update broadcast decodes, fractional-seconds timestamp and all")
    func updateBroadcastPayload() throws {
        guard case let .event(name, payload) = EngineIOPacket.parse(Self.captured[3]) else {
            Issue.record("expected an event")
            return
        }
        #expect(ServerEvent(rawValue: name) == .appUpdateAvailable)

        // `"at":"2026-08-11T20:52:52.533Z"` — the same fractional-seconds format that the stock
        // decoder rejects, arriving over the socket rather than over HTTP. One decoder, one bug
        // fixed once.
        struct UpdatePayload: Decodable { let at: Date }
        let decoded = try RealtimeEvent(name: name, payload: payload).decode(UpdatePayload.self)
        #expect(decoded.at.timeIntervalSince1970 > 1_700_000_000)
    }

    @Test("The CONNECT frame this client sends is the one the server accepted")
    func connectFrameMatchesWhatServerAccepted() {
        // During capture the server answered `40{"sid":...}` to exactly this shape, so this pins
        // the format against an observed success rather than against my reading of the spec.
        let frame = EngineIOOutbound.connect(auth: ["accessToken": "TOKEN"]).text
        #expect(frame == #"40{"accessToken":"TOKEN"}"#)
    }
}
