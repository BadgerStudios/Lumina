import Foundation

#if canImport(FoundationNetworking)
// URLSession lives in a separate module on Linux. Required for this package to build on the CI box
// it is actually developed on — without it nothing here compiles outside Apple platforms, which
// would forfeit the entire reason LuminaKit is a separate target.
import FoundationNetworking
#endif

public enum APIError: Error, Sendable, Equatable {
    case notAuthenticated
    /// The server refused and the session could not be recovered — the caller should sign out.
    case sessionExpired
    case http(status: Int, message: String, code: String?)
    case transport(String)
    case decoding(String)

    /// The message worth showing a person. The backend returns `{ error, code }` with prose written
    /// for end users (see `lib/errors.ts` and the block-reason catalogue), so it is preferred over
    /// anything invented here.
    public var userMessage: String {
        switch self {
        case .notAuthenticated, .sessionExpired: "You've been signed out. Please sign in again."
        case let .http(_, message, _): message
        case .transport: "Couldn't reach Lumina. Check your connection and try again."
        case .decoding: "Lumina sent something this version of the app didn't understand."
        }
    }
}

/// Everything the client needs to persist between launches.
///
/// A protocol rather than a concrete Keychain type so the package still builds and tests on Linux,
/// where there is no Keychain. The iOS app supplies a Keychain-backed implementation; tests supply
/// an in-memory one.
public protocol TokenStorage: Actor {
    func readRefreshToken() -> String?
    func writeRefreshToken(_ token: String?)
}

public actor InMemoryTokenStorage: TokenStorage {
    private var token: String?
    public init(token: String? = nil) { self.token = token }
    public func readRefreshToken() -> String? { token }
    public func writeRefreshToken(_ token: String?) { self.token = token }
}

/// The HTTP client for the Lumina API.
///
/// ## Why an actor
///
/// The access token is mutable state read and written from every screen at once. The interesting
/// case is not a data race on the variable itself but the **refresh stampede**: open the app after
/// a few hours, five views each fire a request, all five get 401, and a naive implementation runs
/// five concurrent refreshes. With refresh-token rotation — which this server does — the first
/// refresh invalidates the token the other four are still holding, so four of them fail and sign
/// the user out. The bug looks like "the app randomly logs me out on launch" and is miserable to
/// reproduce, because it needs concurrency and an expired token at the same time.
///
/// `refreshTask` below is the fix: the first caller to notice a 401 starts the refresh and every
/// other caller awaits *that same task* rather than starting its own.
public actor APIClient {

    public struct Configuration: Sendable {
        public var baseURL: URL
        /// Sent as `X-Device-Fingerprint`. The server records it against the session so a platform
        /// ban can cover a device and not only an account. On iOS this should be
        /// `UIDevice.current.identifierForVendor` — stable per vendor per device, and reset when
        /// the last app from that vendor is deleted, which is the closest thing iOS offers.
        public var deviceFingerprint: String?
        /// Identifies the client as mobile, which is what makes the server return the refresh token
        /// in the response body instead of an httpOnly cookie. A native app has no cookie jar for
        /// the API's origin, exactly like the Capacitor WebView.
        public var clientType: String = "mobile"

        public init(baseURL: URL, deviceFingerprint: String? = nil) {
            self.baseURL = baseURL
            self.deviceFingerprint = deviceFingerprint
        }
    }

    private let configuration: Configuration
    private let session: URLSession
    private let storage: any TokenStorage

    private var accessToken: String?
    private var refreshTask: Task<String, Error>?

    /// Called when the session is lost for good, so the app can route back to sign-in from one
    /// place rather than every call site having to notice `.sessionExpired`.
    public var onSessionExpired: (@Sendable () -> Void)?

    public init(
        configuration: Configuration,
        storage: any TokenStorage,
        session: URLSession = .shared
    ) {
        self.configuration = configuration
        self.storage = storage
        self.session = session
    }

    public func setSessionExpiredHandler(_ handler: @escaping @Sendable () -> Void) {
        onSessionExpired = handler
    }

    public var isAuthenticated: Bool { accessToken != nil }

    /// The current access token, refreshing it first if there isn't one.
    ///
    /// Exists for the realtime client, which needs a *live* token at each connection attempt rather
    /// than one captured once — see RealtimeClient's note on foreground reconnects. Routing it
    /// through here means the socket shares the same refresh-stampede protection as HTTP.
    public func currentAccessToken() async -> String? {
        if let accessToken { return accessToken }
        return try? await refreshSession()
    }

    // MARK: - Requests

    public func get<T: Decodable & Sendable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        try await send(path: path, method: "GET", query: query, body: Optional<Never>.none)
    }

    public func post<T: Decodable & Sendable>(_ path: String, body: (some Encodable & Sendable)? = Optional<Never>.none) async throws -> T {
        try await send(path: path, method: "POST", query: [:], body: body)
    }

    public func patch<T: Decodable & Sendable>(_ path: String, body: (some Encodable & Sendable)? = Optional<Never>.none) async throws -> T {
        try await send(path: path, method: "PATCH", query: [:], body: body)
    }

    public func delete(_ path: String) async throws {
        let _: EmptyResponse = try await send(path: path, method: "DELETE", query: [:], body: Optional<Never>.none)
    }

    /// Performs a request, refreshing the session once on a 401 and replaying it.
    ///
    /// `allowRetry` is what stops an infinite loop: the replayed request is issued with it false, so
    /// a 401 that survives a successful refresh (a revoked session, a banned account) surfaces as
    /// `.sessionExpired` instead of refreshing forever.
    private func send<T: Decodable & Sendable>(
        path: String,
        method: String,
        query: [String: String],
        body: (some Encodable & Sendable)?,
        allowRetry: Bool = true
    ) async throws -> T {
        var request = try makeRequest(path: path, method: method, query: query)
        if let body {
            request.httpBody = try LuminaJSON.encoder.encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let accessToken {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await perform(request)

        if response.statusCode == 401, allowRetry {
            do {
                _ = try await refreshSession()
            } catch {
                await clearSession()
                onSessionExpired?()
                throw APIError.sessionExpired
            }
            return try await send(path: path, method: method, query: query, body: body, allowRetry: false)
        }

        guard (200..<300).contains(response.statusCode) else {
            throw decodeError(data: data, status: response.statusCode)
        }

        // 204, or a body-less 200. Handing `Data()` to JSONDecoder throws a confusing
        // "unexpected end of input" that reads like a server fault rather than an empty success.
        if data.isEmpty, let empty = EmptyResponse() as? T { return empty }

        do {
            return try LuminaJSON.decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw APIError.transport("Non-HTTP response")
            }
            return (data, http)
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
    }

    private func makeRequest(path: String, method: String, query: [String: String]) throws -> URLRequest {
        guard var components = URLComponents(
            url: configuration.baseURL.appendingPathComponent(path.hasPrefix("/") ? String(path.dropFirst()) : path),
            resolvingAgainstBaseURL: false
        ) else {
            throw APIError.transport("Bad URL for \(path)")
        }
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else { throw APIError.transport("Bad URL for \(path)") }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(configuration.clientType, forHTTPHeaderField: "X-Client-Type")
        if let fingerprint = configuration.deviceFingerprint {
            request.setValue(fingerprint, forHTTPHeaderField: "X-Device-Fingerprint")
        }
        return request
    }

    /// The backend's error envelope is `{ error: string, code?: string }`. Falling back to the raw
    /// body keeps a proxy's HTML error page visible in logs instead of being flattened to "unknown".
    private func decodeError(data: Data, status: Int) -> APIError {
        struct Envelope: Decodable { let error: String?; let code: String? }
        if let envelope = try? LuminaJSON.decoder.decode(Envelope.self, from: data), let message = envelope.error {
            return .http(status: status, message: message, code: envelope.code)
        }
        let raw = String(data: data, encoding: .utf8) ?? ""
        return .http(status: status, message: raw.isEmpty ? "Request failed (\(status))" : raw, code: nil)
    }

    // MARK: - Session

    public func signIn(emailOrUsername: String, password: String) async throws -> User {
        struct Body: Encodable, Sendable { let emailOrUsername: String; let password: String }
        let response: AuthResponse = try await send(
            path: "/auth/login", method: "POST", query: [:],
            body: Body(emailOrUsername: emailOrUsername, password: password), allowRetry: false
        )
        try await adopt(response)
        return response.user
    }

    public func register(
        username: String, email: String, password: String,
        ageBracket: AgeBracket, birthDate: Date
    ) async throws -> User {
        struct Body: Encodable, Sendable {
            let username: String, email: String, password: String
            let ageBracket: String, birthDate: String
        }
        // Date only, no time component: the server validates this against the selected bracket and
        // a full timestamp would be rejected as a malformed date of birth.
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: "UTC")

        let response: AuthResponse = try await send(
            path: "/auth/register", method: "POST", query: [:],
            body: Body(
                username: username, email: email, password: password,
                ageBracket: ageBracket.rawValue, birthDate: formatter.string(from: birthDate)
            ),
            allowRetry: false
        )
        try await adopt(response)
        return response.user
    }

    /// Restores a session from the stored refresh token. Returns nil when there is nothing stored,
    /// which is an ordinary first-launch state and not an error.
    public func restoreSession() async throws -> User? {
        guard await storage.readRefreshToken() != nil else { return nil }
        _ = try await refreshSession()
        return try await get("/auth/me") as User
    }

    public func signOut() async {
        // Best-effort: the local session is cleared even if the network call fails, because a user
        // who taps sign out and stays signed in has been actively failed. The server-side token is
        // then orphaned until it expires, which is the lesser problem.
        struct Body: Encodable, Sendable { let refreshToken: String? }
        let token = await storage.readRefreshToken()
        _ = try? await send(
            path: "/auth/logout", method: "POST", query: [:],
            body: Body(refreshToken: token), allowRetry: false
        ) as EmptyResponse
        await clearSession()
    }

    private func adopt(_ response: AuthResponse) async throws {
        accessToken = response.accessToken
        if let refreshToken = response.refreshToken {
            await storage.writeRefreshToken(refreshToken)
        }
    }

    private func clearSession() async {
        accessToken = nil
        refreshTask = nil
        await storage.writeRefreshToken(nil)
    }

    /// Refreshes the access token, collapsing concurrent callers onto one request.
    ///
    /// See the type-level note: with rotation, parallel refreshes invalidate each other and sign the
    /// user out at random. Every caller here awaits the same task.
    private func refreshSession() async throws -> String {
        if let refreshTask { return try await refreshTask.value }

        let task = Task<String, Error> { [storage] in
            guard let refreshToken = await storage.readRefreshToken() else {
                throw APIError.notAuthenticated
            }
            struct Body: Encodable, Sendable { let refreshToken: String }
            let response: AuthResponse = try await self.send(
                path: "/auth/refresh", method: "POST", query: [:],
                body: Body(refreshToken: refreshToken), allowRetry: false
            )
            try await self.adopt(response)
            return response.accessToken
        }
        refreshTask = task

        defer { refreshTask = nil }
        return try await task.value
    }
}

/// Stands in for a response with no body. `Decodable` so it can flow through the generic path, and
/// initialisable so `send` can produce one for a 204 without decoding anything.
public struct EmptyResponse: Codable, Sendable {
    public init() {}
}
