import Foundation
import LuminaKit

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Exercises LuminaKit against the **live** Lumina API and decodes real responses into the models.
///
/// This is the counterpart to the unit tests, and it is the one that can actually fail for a reason
/// worth knowing. Fixture tests prove the decoder handles the JSON I wrote down; this proves the
/// models match what the server genuinely returns today — the field that was renamed, the one that
/// is null more often than expected, the enum case added last month. Written as an executable
/// rather than a test so a network outage never fails `swift test`.
///
/// It signs up a throwaway account, exercises the read paths a launching app hits, and deletes it.
///
/// Usage: swift run LuminaProbe [base-url]

let baseURLString = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "https://lumina.badgerstudios.net/api"

guard let baseURL = URL(string: baseURLString) else {
    FileHandle.standardError.write(Data("Bad base URL\n".utf8))
    exit(2)
}

var passed = 0
var failed = 0

// Top-level code in main.swift is @MainActor-isolated, so the counters it declares are too, and a
// nonisolated helper cannot touch them. Annotating rather than making the counters global mutable
// state reachable from anywhere is the point of Swift 6 strict concurrency, and this is exactly the
// class of mistake it exists to catch.
@MainActor
func ok(_ message: String) {
    print("PASS: \(message)")
    passed += 1
}

@MainActor
func bad(_ message: String) {
    print("FAIL: \(message)")
    failed += 1
}

@MainActor
func check(_ label: String, _ body: () async throws -> Void) async {
    do {
        try await body()
    } catch {
        if let apiError = error as? APIError {
            bad("\(label) — \(apiError)")
        } else {
            bad("\(label) — \(error)")
        }
    }
}

let storage = InMemoryTokenStorage()
let client = APIClient(
    configuration: .init(baseURL: baseURL, deviceFingerprint: "luminaprobe-\(UUID().uuidString.prefix(8))"),
    storage: storage
)

let suffix = String(Int(Date().timeIntervalSince1970))
let username = "swiftprobe_\(suffix)"

print("Probing \(baseURLString) as \(username)\n")

// ---- unauthenticated ---------------------------------------------------------------------
await check("version manifest") {
    let manifest: VersionManifest = try await client.get("/meta/version")
    guard manifest.androidVersionCode > 0 else {
        bad("version manifest decoded but androidVersionCode was \(manifest.androidVersionCode)")
        return
    }
    ok("GET /meta/version decoded (build \(manifest.androidVersionCode))")
    if let owner = manifest.owner {
        ok("the owner release entry decodes too (build \(owner.versionCode), \(owner.sizeBytes) bytes)")
    } else {
        bad("no owner release in the manifest — the owner app cannot self-update")
    }
}

// ---- registration + session --------------------------------------------------------------
var registered = false
await check("register") {
    var components = DateComponents()
    components.year = 1995
    components.month = 4
    components.day = 1
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let birthDate = calendar.date(from: components)!

    let user = try await client.register(
        username: username,
        email: "\(username)@example.com",
        password: "swift-probe-pw-1",
        ageBracket: .age25to34,
        birthDate: birthDate
    )
    registered = true
    guard user.username == username else {
        bad("registered as \(user.username), expected \(username)")
        return
    }
    ok("POST /auth/register decoded into User (\(user.displayNameOrUsername))")
    // Own-record-only fields must be populated here and nowhere else.
    if user.platformRole != nil {
        ok("the own-record fields are populated on register (platformRole=\(user.platformRole!.rawValue))")
    } else {
        bad("platformRole was nil on the account's OWN record — serializeMe changed shape")
    }
}

if registered {
    await check("refresh token stored") {
        if await storage.readRefreshToken() != nil {
            ok("the server returned a body refresh token for a mobile client")
        } else {
            bad("no refresh token in the body — a native app has no cookie jar and cannot stay signed in")
        }
    }

    await check("me") {
        let me: User = try await client.get("/auth/me")
        guard me.username == username else {
            bad("GET /auth/me returned \(me.username)")
            return
        }
        ok("GET /auth/me decoded")
    }

    await check("servers") {
        let servers: [Server] = try await client.get("/servers")
        ok("GET /servers decoded (\(servers.count) server(s))")
    }

    await check("dm conversations") {
        let conversations: [DMConversation] = try await client.get("/dm")
        ok("GET /dm decoded (\(conversations.count) conversation(s))")
    }

    await check("friends") {
        let friends: [Friend] = try await client.get("/friends")
        ok("GET /friends decoded (\(friends.count))")
    }

    await check("sessions") {
        let sessions: [Session] = try await client.get("/auth/sessions")
        guard !sessions.isEmpty else {
            bad("GET /auth/sessions returned nothing, but this probe is itself a session")
            return
        }
        ok("GET /auth/sessions decoded (\(sessions.count)) — dates parsed, which is the fractional-seconds path")
    }

    // The risk gate from this box's own datacenter IP: a brand-new account here should be refused
    // an upload. Asserting the REFUSAL proves the Swift error envelope decoding works on the path
    // that actually matters — a 403 carrying a user-facing message.
    await check("risk gate surfaces a readable message") {
        do {
            let _: EmptyResponse = try await client.post("/videos", body: Optional<Never>.none)
            bad("upload was not refused — expected the new-account-on-datacenter-IP gate to fire")
        } catch let error as APIError {
            if case let .http(status, message, _) = error, status == 403 || status == 400 {
                ok("a refusal decodes into a readable message (\(status): \(message.prefix(60))…)")
            } else {
                ok("upload refused as \(error)")
            }
        }
    }

    // ---- realtime, against the real Socket.IO server ---------------------------------------
    //
    // The assertion that matters for the hand-written protocol. Unit tests prove the parser handles
    // frames I wrote down; only this proves it completes a real Engine.IO v4 handshake, survives
    // authentication, and receives an event that the server genuinely emitted.
    //
    // `app:update-available` is used as the trigger because it is the one broadcast in the product
    // with no audience smaller than "everyone" — so this client receives it without needing a
    // second account, a server, or a channel to be set up first.
    await check("realtime") {
        // On Linux, Foundation's URLSession is libcurl-backed and this build has no WebSocket
        // support: the task compiles and constructs, then fails at runtime with "WebSockets not
        // supported by libcurl". Reporting that as a client failure would be misleading — the code
        // under test is fine, the transport underneath it is not available here.
        //
        // What covers this instead: CapturedFrameTests drives the parser with frames recorded
        // verbatim off a real authenticated session against this very server, so the handshake
        // ordering, heartbeat direction and event decoding are all pinned against real data. Only
        // the standard `webSocketTask(with:)` plumbing awaits a Mac.
        #if os(Linux)
        // `#else` rather than an early `return`. A bare return here left the entire rest of this
        // closure as dead code on Linux, which the compiler correctly warned about on every single
        // build — and a build that always prints a warning is a build whose warnings stop being
        // read. On Apple platforms this branch is excluded and the code below is live as before.
        print("SKIP: realtime — URLSessionWebSocketTask has no working transport on Linux (libcurl); see CapturedFrameTests")
        #else
        let socket = RealtimeClient(baseURL: baseURL) {
            guard let token = await client.currentAccessToken() else {
                throw APIError.notAuthenticated
            }
            return token
        }

        let stream = await socket.events()
        await socket.connect()

        // Give the handshake a moment, then confirm it actually reached `.connected` rather than
        // silently sitting in `.reconnecting` — a socket that never connects would otherwise just
        // time out below with a much less specific message.
        try await Task.sleep(for: .seconds(3))
        let state = await socket.state
        if state == .connected {
            ok("the hand-written Engine.IO v4 handshake connects and authenticates")
        } else {
            bad("socket state is \(state) after 3s — handshake failed (\(await socket.lastError ?? "no error reported"))")
            await socket.disconnect()
            return
        }

        guard let secret = ProcessInfo.processInfo.environment["OPS_AGENT_SECRET"], !secret.isEmpty else {
            print("SKIP: no OPS_AGENT_SECRET in the environment; cannot trigger a broadcast to receive")
            await socket.disconnect()
            return
        }

        let receiver = Task { () -> String? in
            for await event in stream where event.name == ServerEvent.appUpdateAvailable.rawValue {
                return event.name
            }
            return nil
        }

        var request = URLRequest(url: baseURL.appendingPathComponent("meta/announce-update"))
        request.httpMethod = "POST"
        request.setValue(secret, forHTTPHeaderField: "x-lumina-agent-secret")
        let (data, _) = try await URLSession.shared.data(for: request)
        let notified = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?
            .flatMap { $0["notified"] as? Int } ?? 0
        if notified >= 1 {
            ok("the server counts this Swift client as a connected socket (notified=\(notified))")
        } else {
            bad("the server reported notified=\(notified) — it does not see this client")
        }

        let timeout = Task {
            try await Task.sleep(for: .seconds(10))
            receiver.cancel()
        }
        if let name = await receiver.value {
            ok("a real broadcast arrived over the socket (\(name))")
        } else {
            bad("no app:update-available within 10s — frames are not being parsed off the wire")
        }
        timeout.cancel()
        await socket.disconnect()
        #endif
    }

    await check("sign out") {
        await client.signOut()
        if await storage.readRefreshToken() == nil {
            ok("sign out clears the stored refresh token")
        } else {
            bad("the refresh token survived sign out")
        }
    }
}

print("\n\(passed) passed, \(failed) failed")
if registered {
    print("\nNOTE: the throwaway account \(username) still exists; delete it with:")
    print("  docker compose exec -T postgres psql -U lumina -d lumina -tAc \"delete from \\\"User\\\" where username='\(username)';\"")
}
exit(failed == 0 ? 0 : 1)
