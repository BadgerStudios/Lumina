// swift-tools-version: 6.0
import PackageDescription

/// LuminaKit — every part of the native client that is not a view.
///
/// ## Why this is a separate package rather than files in the app target
///
/// Two reasons, and the second is the load-bearing one:
///
/// 1. It keeps the API contract in one place, so the iOS app and any future macOS/watchOS target
///    share a single definition of what the server returns rather than each drifting on their own.
///
/// 2. **It compiles and unit-tests on Linux.** SwiftUI and UIKit exist only on Apple platforms, so
///    an iOS app written on a Linux box is entirely unverifiable — you find out whether it builds
///    when someone finally opens Xcode. Foundation, URLSession, Codable and swift-testing all work
///    on Linux. By putting the models, the HTTP client, session handling and the realtime layer
///    here — with no import of SwiftUI anywhere in this target — the majority of the app's actual
///    logic is compiled and tested on every change, and only the view layer waits for a Mac.
///
/// Nothing in this target may import SwiftUI, UIKit or Combine. That restriction is what buys the
/// verification, and it is enforced by CI-on-Linux failing the moment it is broken.
let package = Package(
    name: "LuminaKit",
    platforms: [
        // Only consulted when built on an Apple platform; ignored on Linux.
        .iOS(.v17), .macOS(.v14),
    ],
    products: [
        .library(name: "LuminaKit", targets: ["LuminaKit"]),
        // Runs the client against the live API. An executable rather than a test target on purpose:
        // it needs the network and a real server, so a connectivity blip must never fail
        // `swift test`. See Sources/LuminaProbe/main.swift.
        .executable(name: "LuminaProbe", targets: ["LuminaProbe"]),
    ],
    targets: [
        .target(
            name: "LuminaKit",
            swiftSettings: [
                // Strict concurrency from day one rather than retrofitted. The client is shared
                // mutable state reached from every screen at once; the compiler catching that is
                // considerably cheaper than debugging it on a device.
                .enableUpcomingFeature("StrictConcurrency"),
            ]
        ),
        .executableTarget(name: "LuminaProbe", dependencies: ["LuminaKit"]),
        .testTarget(name: "LuminaKitTests", dependencies: ["LuminaKit"]),
    ]
)
