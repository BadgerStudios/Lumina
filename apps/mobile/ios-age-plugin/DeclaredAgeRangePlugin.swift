import Foundation
import Capacitor
import DeviceCheck
import CryptoKit

// Apple Declared Age Range — iOS 26+. This is the native age-band source for the iOS build, the
// counterpart to the Android AgeSignalsPlugin. It returns a coarse band (never a birthdate) and,
// alongside it, an App Attest assertion so the Lumina backend can prove the band came from the
// genuine, unmodified app before trusting it (verification/attestation.ts, fail-closed).
//
// NOTE ON THE Apple API SURFACE: `DeclaredAgeRange` shipped in iOS 26.2 and its exact type names are
// still settling in the docs. The call below follows the documented shape (AgeRangeService →
// requestAgeRange(ageGates:) → .sharing(range)/.declinedSharing with range.lowerBound/.upperBound).
// CONFIRM against the installed iOS 26.2 SDK in Xcode when wiring this up; adjust the enum/case names
// if Apple's final names differ. Everything is guarded so an unavailable framework degrades to
// "unavailable" rather than crashing — matching the server's fall-back-to-self-declared behavior.
#if canImport(DeclaredAgeRange)
import DeclaredAgeRange
#endif

@objc(DeclaredAgeRangePlugin)
public class DeclaredAgeRangePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DeclaredAgeRangePlugin"
    public let jsName = "DeclaredAgeRange"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestAgeSignal", returnType: CAPPluginReturnPromise)
    ]

    /// Returns { available, band, attestationToken }. `band` is one of "18+", "16-17", "13-15",
    /// "0-12" (mapped from the declared range), or absent when the user declines / the OS is too old.
    @objc func requestAgeSignal(_ call: CAPPluginCall) {
        #if canImport(DeclaredAgeRange)
        if #available(iOS 26.0, *) {
            Task {
                do {
                    let service = AgeRangeService()
                    // Ask about the two boundaries the platform cares about: 16 (minimum age) and 18
                    // (adult / feed). The response's lowerBound tells us which band the user is in.
                    let response = try await service.requestAgeRange(ageGates: 16, 18)
                    switch response {
                    case .declinedSharing:
                        call.resolve(["available": false, "reason": "declined"])
                    case .sharing(let range):
                        let band = Self.bandFrom(lowerBound: range.lowerBound, upperBound: range.upperBound)
                        // Attach an App Attest assertion over the band so the server can trust it.
                        let token = await Self.appAttestToken(for: band)
                        var result: [String: Any] = ["available": true, "band": band]
                        if let token = token { result["attestationToken"] = token }
                        call.resolve(result)
                    @unknown default:
                        call.resolve(["available": false, "reason": "unknown"])
                    }
                } catch {
                    call.resolve(["available": false, "reason": "error"])
                }
            }
            return
        }
        #endif
        // Framework unavailable (< iOS 26 or SDK without DeclaredAgeRange) — server falls back to
        // the self-declared birthday, exactly as on web.
        call.resolve(["available": false, "reason": "unsupported"])
    }

    /// Map Apple's declared lower/upper bounds to the platform's band vocabulary.
    private static func bandFrom(lowerBound: Int?, upperBound: Int?) -> String {
        let low = lowerBound ?? 0
        if low >= 18 { return "18+" }
        if low >= 16 { return "16-17" }
        if low >= 13 { return "13-15" }
        if let up = upperBound, up < 13 { return "0-12" }
        return low >= 13 ? "13-15" : "0-12"
    }

    // MARK: - App Attest

    /// Produce an App Attest assertion binding this request's band, or nil if App Attest is
    /// unsupported/unenrolled. The server verifies this before granting DEVICE_DECLARED assurance.
    /// (Server-side App Attest verification is the fail-closed stub in attestation.ts to finish.)
    private static func appAttestToken(for band: String) async -> String? {
        let service = DCAppAttestService.shared
        guard service.isSupported else { return nil }
        do {
            let keyId = try await service.generateKey()
            // The assertion is over a hash of what we're claiming — the band — so the server can bind
            // the attestation to this specific signal.
            let clientData = Data(band.utf8)
            let hash = Data(SHA256.hash(data: clientData))
            let assertion = try await service.generateAssertion(keyId, clientDataHash: hash)
            // Package keyId + assertion so the server can verify. base64 for JSON transport.
            let payload: [String: String] = [
                "keyId": keyId,
                "assertion": assertion.base64EncodedString(),
                "band": band
            ]
            guard let json = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
            return json.base64EncodedString()
        } catch {
            return nil
        }
    }
}
