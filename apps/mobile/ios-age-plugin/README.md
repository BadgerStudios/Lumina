# iOS Declared Age Range plugin — Mac/Xcode setup

This directory is a **scaffold**. The iOS app doesn't exist in the repo yet (there is no
`apps/mobile/ios/`), and iOS apps can't be built on the Linux host Lumina runs on. These files are
ready to drop into a Capacitor iOS project on a **Mac with Xcode 26.2 / the iOS 26.2 SDK**.

The Swift plugin (`DeclaredAgeRangePlugin.swift`) is the iOS counterpart of the Android
`AgeSignalsPlugin`: it returns a coarse age **band** (never a birthdate) from Apple's
`DeclaredAgeRange` framework, plus an **App Attest** assertion so the Lumina backend can prove the
band came from the genuine app before trusting it (`apps/backend/src/modules/verification/`).

## One-time, on a Mac

1. **Add the iOS platform** (from repo root):
   ```bash
   cd apps/mobile
   npm run --prefix ../.. build:mobile   # or: (cd ../frontend && npm run build:mobile)
   npx cap add ios
   npx cap copy ios
   ```
   This creates `apps/mobile/ios/App/App.xcworkspace`.

2. **Add this plugin** to the app target:
   - Copy `DeclaredAgeRangePlugin.swift` into `apps/mobile/ios/App/App/plugins/`.
   - Capacitor 6+ auto-discovers a `CAPBridgedPlugin` in the app target — no manual registration
     needed. (If on an older Capacitor, add a `.m` with the `CAP_PLUGIN` macro.)

3. **Entitlements & capabilities** (Xcode → Signing & Capabilities):
   - Add the **Declared Age Range** entitlement: key `com.apple.developer.declared-age-range`,
     type Boolean, value `YES` (in `App.entitlements`). This entitlement requires enabling the
     capability on the App ID in the Apple Developer portal.
   - Add the **App Attest** capability (`com.apple.developer.devicecheck.appattest-environment`),
     `production` for release.

4. **Deployment target**: set iOS Deployment Target to **26.0+** and build against the iOS 26.2 SDK
   (Xcode 26.2). On devices below 26 the plugin resolves `{ available: false }` and the app falls
   back to the self-declared birthday, exactly like web.

5. **Confirm the framework API**: `DeclaredAgeRange` is new in 26.2 and its final type/case names
   may differ slightly from the scaffold (`AgeRangeService`, `requestAgeRange(ageGates:)`,
   `.sharing(range)` / `.declinedSharing`). Fix any mismatch against the SDK — the file is heavily
   commented at the call site.

## Build / ship

```bash
cd apps/mobile/ios/App
xcodebuild -workspace App.xcworkspace -scheme App -configuration Release \
  -sdk iphoneos archive -archivePath build/App.xcarchive
# then export + upload to App Store Connect / TestFlight
```

App Store review will scrutinise the `declared-age-range` entitlement (Apple gates it). Until the
build is approved and on a 26.2 device, the iOS native path stays dormant and users fall back to
self-declared + Persona/selfie — no functional gap, just weaker assurance on iOS.

## Backend side (already shipped)

- `POST /api/verification/device-signal` accepts `{ platform: "ios", band, attestationToken }`.
- The frontend calls it via `getNativeAgeSignal()` when running natively (see the shared frontend
  helper). The **server-side App Attest verification** in `verification/attestation.ts` is currently
  a fail-closed stub (`verifyAppAttest` returns false) — finish it (validate the App Attest assertion
  chain + clientDataHash against `APPLE_APP_ATTEST_TEAM_ID`/`_BUNDLE_ID`) so iOS bands are trusted.
  Until then iOS `device-signal` records the signal but does not upgrade assurance — safe by default.
