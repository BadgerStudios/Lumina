import Foundation

/// The slice of the Engine.IO v4 / Socket.IO v4 wire protocol this app actually uses.
///
/// ## Why hand-written instead of `socket.io-client-swift`
///
/// The obvious move is the community client. It pulls in Starscream and is maintained against
/// Apple platforms; building it on Linux is at best unsupported. That matters here specifically,
/// because LuminaKit's whole reason for existing is that it compiles and tests on the Linux box
/// this project is developed on. A dependency that only builds on macOS would move the realtime
/// layer — the most timing-dependent, least eyeball-verifiable part of the client — into the
/// unverifiable bucket alongside the views.
///
/// `URLSessionWebSocketTask` is available on Linux (checked, not assumed), and the protocol subset
/// needed here is genuinely small: an open packet, a connect packet with auth, event frames, and a
/// heartbeat. That is a few dozen lines of parsing, exercised against the real server.
///
/// ## The frames, as the server actually sends them
///
/// Engine.IO wraps Socket.IO. The first character is the Engine.IO packet type; for MESSAGE (`4`)
/// the next character is the Socket.IO packet type:
///
///     0{"sid":"...","pingInterval":25000,"pingTimeout":20000}   Engine.IO OPEN
///     2                                                          Engine.IO PING  (server → client)
///     3                                                          Engine.IO PONG  (client → server)
///     40{"accessToken":"..."}                                    Socket.IO CONNECT, with auth
///     40{"sid":"..."}                                            Socket.IO CONNECT ack
///     41                                                         Socket.IO DISCONNECT
///     42["message:create",{...}]                                 Socket.IO EVENT
///     44{"message":"Invalid or expired access token"}            Socket.IO CONNECT_ERROR
///
/// The direction of the heartbeat is the detail most implementations get backwards: in Engine.IO
/// **v4 the server sends PING and the client replies PONG**, the reverse of v3. Getting it wrong
/// produces a connection that works perfectly for `pingTimeout` and then drops every time, which
/// reads as a flaky network rather than a protocol bug.
enum EngineIOPacket {
    case open(sid: String, pingInterval: Int, pingTimeout: Int)
    case ping
    case pong
    case close
    case connected(sid: String)
    case disconnected
    case event(name: String, payload: Data?)
    case connectError(message: String)
    case unhandled(String)

    /// Parses one text frame. Never throws: an unrecognised frame from a newer server must not tear
    /// down a working connection, so anything unknown becomes `.unhandled` and is ignored.
    static func parse(_ text: String) -> EngineIOPacket {
        guard let first = text.first else { return .unhandled(text) }
        let rest = String(text.dropFirst())

        switch first {
        case "0":
            guard
                let data = rest.data(using: .utf8),
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let sid = json["sid"] as? String
            else { return .unhandled(text) }
            return .open(
                sid: sid,
                pingInterval: json["pingInterval"] as? Int ?? 25000,
                pingTimeout: json["pingTimeout"] as? Int ?? 20000
            )
        case "1": return .close
        case "2": return .ping
        case "3": return .pong
        case "4":
            return parseSocketIO(rest)
        default:
            return .unhandled(text)
        }
    }

    private static func parseSocketIO(_ text: String) -> EngineIOPacket {
        guard let first = text.first else { return .unhandled(text) }
        let rest = String(text.dropFirst())

        switch first {
        case "0":
            let sid = (try? JSONSerialization.jsonObject(with: Data(rest.utf8)) as? [String: Any])?
                .flatMap { $0["sid"] as? String } ?? ""
            return .connected(sid: sid)
        case "1":
            return .disconnected
        case "2":
            // `["eventName", payload]`. The payload is re-serialised rather than handed over as a
            // JSONSerialization object graph, so callers decode it with the same Codable models and
            // the same date strategy as every REST response — one definition of the wire shape, not
            // two that can drift.
            guard
                let array = try? JSONSerialization.jsonObject(with: Data(rest.utf8)) as? [Any],
                let name = array.first as? String
            else { return .unhandled(text) }

            var payload: Data?
            if array.count > 1 {
                payload = try? JSONSerialization.data(withJSONObject: array[1])
            }
            return .event(name: name, payload: payload)
        case "4":
            let message = (try? JSONSerialization.jsonObject(with: Data(rest.utf8)) as? [String: Any])?
                .flatMap { $0["message"] as? String } ?? "Connection refused"
            return .connectError(message: message)
        default:
            return .unhandled(text)
        }
    }
}

/// Frames this client sends.
enum EngineIOOutbound {
    case pong
    case connect(auth: [String: String])
    case event(name: String, payload: Any?)

    var text: String {
        switch self {
        case .pong:
            return "3"
        case let .connect(auth):
            let json = (try? JSONSerialization.data(withJSONObject: auth))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            return "40\(json)"
        case let .event(name, payload):
            var array: [Any] = [name]
            if let payload { array.append(payload) }
            let json = (try? JSONSerialization.data(withJSONObject: array))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
            return "42\(json)"
        }
    }
}
