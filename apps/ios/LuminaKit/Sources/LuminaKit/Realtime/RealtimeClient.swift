import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Names of the server-to-client events, mirroring `packages/shared/src/events.ts`.
public enum ServerEvent: String, Sendable {
    case messageCreate = "message:create"
    case messageUpdate = "message:update"
    case messageDelete = "message:delete"
    case reactionAdd = "reaction:add"
    case reactionRemove = "reaction:remove"
    case typingUpdate = "typing:update"
    case presenceUpdate = "presence:update"
    case memberJoin = "member:join"
    case memberUpdate = "member:update"
    case memberLeave = "member:leave"
    case channelCreate = "channel:create"
    case channelUpdate = "channel:update"
    case channelDelete = "channel:delete"
    case dmCreate = "dm:create"
    case appUpdateAvailable = "app:update-available"
}

public struct RealtimeEvent: Sendable {
    public let name: String
    public let payload: Data?

    /// Decodes the payload with the same coder as every REST response, so a `Message` arriving over
    /// the socket and the same message fetched over HTTP are parsed by identical code — including
    /// the fractional-seconds date handling that trips up the stock decoder.
    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        guard let payload else {
            throw APIError.decoding("event \(name) carried no payload")
        }
        return try LuminaJSON.decoder.decode(type, from: payload)
    }

    public var known: ServerEvent? { ServerEvent(rawValue: name) }
}

public enum RealtimeState: Sendable, Equatable {
    case disconnected
    case connecting
    case connected
    /// Waiting out backoff before another attempt. `attempt` is 1-based.
    case reconnecting(attempt: Int)
}

/// Socket.IO client for the Lumina realtime API.
///
/// ## What this is responsible for beyond moving bytes
///
/// A chat app's realtime layer is judged almost entirely on how it behaves when the network is
/// *bad*, not when it works. Three things matter, and each is a deliberate choice here:
///
/// 1. **Reconnect with backoff and jitter.** A phone leaving a tunnel reconnects; so does every
///    other phone on that train, at the same instant. Fixed-interval retries turn a brief outage
///    into a synchronised stampede against the server. Delays grow geometrically and carry random
///    jitter so clients spread out.
///
/// 2. **A fresh access token on every attempt.** Tokens expire, and the single most common moment
///    to reconnect is when the app returns to the foreground after hours in the background — i.e.
///    exactly when the token is stale. Reusing the token captured at first connect produces an
///    endless reconnect loop, each attempt refused with "Invalid or expired access token". The
///    token is therefore fetched through a closure at connect time rather than passed in once.
///
/// 3. **Events are buffered, not dropped.** Consumers come and go with the view hierarchy; an
///    `AsyncStream` with a bounded buffer means a screen that is mid-navigation doesn't lose the
///    message that arrived during the transition. Bounded rather than unbounded so a consumer that
///    stops draining cannot grow memory without limit.
public actor RealtimeClient {

    public typealias TokenProvider = @Sendable () async throws -> String

    private let baseURL: URL
    private let tokenProvider: TokenProvider
    private let session: URLSession

    private var task: URLSessionWebSocketTask?
    private var receiveLoop: Task<Void, Never>?
    private var heartbeatDeadline: Task<Void, Never>?
    private var reconnectAttempt = 0
    private var reconnectTask: Task<Void, Never>?
    private var intentionallyClosed = false

    private var continuation: AsyncStream<RealtimeEvent>.Continuation?
    public private(set) var state: RealtimeState = .disconnected

    private var stateObservers: [@Sendable (RealtimeState) -> Void] = []

    /// Caps the backoff. Beyond ~30s a user staring at a disconnected app would rather it kept
    /// trying briskly than doubled its way to several minutes.
    private let maxBackoff: TimeInterval = 30

    public init(baseURL: URL, session: URLSession = .shared, tokenProvider: @escaping TokenProvider) {
        // The socket lives at the origin, not under /api — `https://host/api` must become
        // `wss://host/socket.io/`. Getting this wrong yields a 404 on upgrade that surfaces only as
        // "the socket won't connect".
        self.baseURL = baseURL
        self.session = session
        self.tokenProvider = tokenProvider
    }

    public func events() -> AsyncStream<RealtimeEvent> {
        AsyncStream(bufferingPolicy: .bufferingNewest(256)) { continuation in
            self.continuation = continuation
        }
    }

    public func observeState(_ observer: @escaping @Sendable (RealtimeState) -> Void) {
        stateObservers.append(observer)
        observer(state)
    }

    private func setState(_ next: RealtimeState) {
        state = next
        for observer in stateObservers { observer(next) }
    }

    public func connect() async {
        intentionallyClosed = false
        await openSocket()
    }

    public func disconnect() {
        intentionallyClosed = true
        // Without this a sign-out is followed, seconds later, by the pending backoff firing and
        // reconnecting the socket the user just closed.
        reconnectTask?.cancel()
        reconnectTask = nil
        teardown()
        setState(.disconnected)
    }

    /// Emits a client event, e.g. `channel:join`.
    public func emit(_ event: String, _ payload: Any? = nil) async {
        guard let task else { return }
        let frame = EngineIOOutbound.event(name: event, payload: payload).text
        try? await task.send(.string(frame))
    }

    // MARK: - Connection lifecycle

    private func openSocket() async {
        guard !intentionallyClosed else { return }
        setState(reconnectAttempt == 0 ? .connecting : .reconnecting(attempt: reconnectAttempt))

        let token: String
        do {
            // Fetched per attempt, never cached — see the type-level note. This is what stops a
            // background-to-foreground reconnect looping forever on an expired token.
            token = try await tokenProvider()
        } catch {
            await scheduleReconnect()
            return
        }

        guard var components = URLComponents(url: socketURL(), resolvingAgainstBaseURL: false) else {
            await scheduleReconnect()
            return
        }
        components.queryItems = [
            URLQueryItem(name: "EIO", value: "4"),
            URLQueryItem(name: "transport", value: "websocket"),
        ]
        guard let url = components.url else {
            await scheduleReconnect()
            return
        }

        let socket = session.webSocketTask(with: url)
        task = socket
        socket.resume()

        // The CONNECT frame carrying auth is sent when the server's OPEN arrives, not here — the
        // server rejects a Socket.IO packet that precedes the Engine.IO handshake.
        pendingAuthToken = token
        startReceiveLoop(socket)
    }

    private var pendingAuthToken: String?

    /// `https://host/api` → `wss://host/socket.io/`.
    private func socketURL() -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.scheme = (baseURL.scheme == "http") ? "ws" : "wss"
        components?.path = "/socket.io/"
        components?.query = nil
        return components?.url ?? baseURL
    }

    private func startReceiveLoop(_ socket: URLSessionWebSocketTask) {
        receiveLoop?.cancel()
        receiveLoop = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await socket.receive()
                    guard let self else { return }
                    switch message {
                    case let .string(text):
                        await self.handle(text: text, socket: socket)
                    case let .data(data):
                        // The server never sends binary frames for this app's events; decoding one
                        // as UTF-8 is the tolerant thing to do rather than dropping it silently.
                        if let text = String(data: data, encoding: .utf8) {
                            await self.handle(text: text, socket: socket)
                        }
                    @unknown default:
                        break
                    }
                } catch {
                    guard let self else { return }
                    await self.handleDrop()
                    return
                }
            }
        }
    }

    private func handle(text: String, socket: URLSessionWebSocketTask) async {
        switch EngineIOPacket.parse(text) {
        case let .open(_, pingInterval, pingTimeout):
            // Auth travels in the Socket.IO CONNECT packet, which may only be sent after this.
            if let pendingAuthToken {
                let frame = EngineIOOutbound.connect(auth: ["accessToken": pendingAuthToken]).text
                try? await socket.send(.string(frame))
            }
            armHeartbeatWatchdog(intervalMs: pingInterval, timeoutMs: pingTimeout)

        case .connected:
            reconnectAttempt = 0
            setState(.connected)

        case .ping:
            // v4: server pings, client pongs. Reversing this is the classic bug — everything works
            // until pingTimeout elapses, then the server closes, every time.
            try? await socket.send(.string(EngineIOOutbound.pong.text))
            armHeartbeatWatchdog()

        case let .connectError(message):
            // Almost always an expired token. Tearing down and reconnecting re-runs the token
            // provider, which is the fix rather than retrying with the same rejected credential.
            lastError = message
            await handleDrop()

        case .disconnected, .close:
            await handleDrop()

        case .pong, .event, .unhandled:
            if case let .event(name, payload) = EngineIOPacket.parse(text) {
                continuation?.yield(RealtimeEvent(name: name, payload: payload))
            }
        }
    }

    public private(set) var lastError: String?

    /// Independent of the socket's own liveness: a TCP connection can stay "open" long after the
    /// peer is unreachable — the classic case is a phone moving between networks, where nothing is
    /// delivered and nothing errors. Missing two ping intervals means the link is dead regardless
    /// of what the socket claims.
    private func armHeartbeatWatchdog(intervalMs: Int = 25000, timeoutMs: Int = 20000) {
        heartbeatDeadline?.cancel()
        let deadline = Double(intervalMs + timeoutMs) / 1000
        heartbeatDeadline = Task { [weak self] in
            try? await Task.sleep(for: .seconds(deadline))
            guard !Task.isCancelled, let self else { return }
            await self.handleDrop()
        }
    }

    private func handleDrop() async {
        teardown()
        guard !intentionallyClosed else { return }
        await scheduleReconnect()
    }

    private func teardown() {
        // Deliberately NOT `receiveLoop?.cancel()`. teardown() is reached from inside the receive
        // loop (a dropped connection calls handleDrop from there), so cancelling it cancels the very
        // task that is still executing the reconnect path below — and `try? await Task.sleep` in a
        // cancelled task returns INSTANTLY. The backoff silently becomes a tight spin: 2583 attempts
        // in three seconds, observed. Cancelling the socket is enough; receive() then throws and the
        // loop returns on its own.
        receiveLoop = nil
        heartbeatDeadline?.cancel()
        heartbeatDeadline = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        pendingAuthToken = nil
    }

    private func scheduleReconnect() async {
        // One pending reconnect at a time. Without this guard a drop that is noticed from two
        // places at once (the receive loop erroring AND the heartbeat watchdog firing) schedules
        // two, and the attempt counter runs away.
        guard reconnectTask == nil else { return }

        reconnectAttempt += 1
        setState(.reconnecting(attempt: reconnectAttempt))

        // Geometric backoff with full jitter. The jitter is not cosmetic: without it every client
        // dropped by the same server restart returns in lockstep and knocks it over again.
        let base = min(maxBackoff, pow(2, Double(min(reconnectAttempt, 6))))
        let delay = Double.random(in: (base / 2)...base)

        // An UNSTRUCTURED task, on purpose: `Task {}` does not inherit cancellation from whatever
        // called it, which is exactly what is needed here — the caller is often a task that has just
        // been cancelled, and inheriting that would make the sleep return immediately.
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled else { return }
            await self.clearReconnectTask()
            await self.openSocket()
        }
    }

    private func clearReconnectTask() {
        reconnectTask = nil
    }
}
