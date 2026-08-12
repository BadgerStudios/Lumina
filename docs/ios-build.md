# Building and testing the iOS client from Linux

There is no Swift toolchain installed on this box and no Mac attached to it. That is not a reason to
leave the native client unverified — most of it does not need either.

## How the package is split, and why

`apps/ios/LuminaKit` is a SwiftPM package containing **everything in the native client that is not a
view**: the models, the HTTP client, session/token handling, and the hand-written Socket.IO
protocol. Nothing in it imports SwiftUI, UIKit or Combine, deliberately.

That restriction is what makes it buildable and testable here. Foundation, URLSession, Codable and
swift-testing all work on Linux; SwiftUI and UIKit do not exist off Apple platforms. Keeping the
logic in a view-free target means the majority of the app is compiled and unit-tested on every
change, and only the view layer waits for a Mac.

## Running the build

```bash
cd apps/ios/LuminaKit

# Compile
docker run --rm -v "$PWD":/pkg -w /pkg swift:6.0-jammy swift build

# Unit tests — parser, decoding, and frames captured verbatim off a real session
docker run --rm -v "$PWD":/pkg -w /pkg swift:6.0-jammy swift test

# End-to-end against the live API: registers a throwaway account, exercises every
# decode path, then signs out. Prints the cleanup command for the account it made.
docker run --rm --network host -v "$PWD":/pkg -w /pkg swift:6.0-jammy swift run LuminaProbe
```

Two things to know about the container:

- It runs as **root**, so `.build/` ends up root-owned and cannot be deleted from the host. Remove
  it the same way it was made: `docker run --rm -v "$PWD":/pkg swift:6.0-jammy rm -rf /pkg/.build`.
- Mount paths are created on the host if missing. Running the command from the wrong directory
  silently creates an empty tree rather than failing, so check `pwd` first.

## What is genuinely blocked on a Mac

- The SwiftUI view layer and the `.xcodeproj`/scheme.
- Signing, provisioning profiles, a simulator or device run, and anything resembling TestFlight.
- The realtime probe's live socket leg. Linux Foundation's URLSession is libcurl-backed and has no
  WebSocket transport, so `URLSessionWebSocketTask` constructs and then fails at runtime with
  "WebSockets not supported by libcurl" — a limitation of the transport here, not of the client.
  `CapturedFrameTests` covers it instead by driving the parser with frames recorded verbatim from a
  real authenticated session against this server, which pins handshake ordering, heartbeat direction
  and event decoding against real data.

Writing the SwiftUI layer here would produce a few thousand lines that have never been near a
compiler. That is worse than not writing them: it looks finished and is not.
