import Foundation

/// JSON coders configured for what this specific backend actually emits.
public enum LuminaJSON {

    /// Decoder for every API response.
    ///
    /// ## The date strategy is the whole point of this file
    ///
    /// Foundation's `.iso8601` strategy uses `ISO8601DateFormatter` with its default options, which
    /// **rejects fractional seconds**. The backend produces its timestamps with JavaScript's
    /// `Date.prototype.toISOString()`, which *always* emits exactly three decimal places:
    ///
    ///     "2026-08-11T20:11:38.191Z"
    ///
    /// So the obvious `decoder.dateDecodingStrategy = .iso8601` fails on literally every timestamp
    /// this server sends. It is a particularly nasty bug to meet in the wild because it presents as
    /// "the whole screen is empty" rather than "this date is wrong", and because any hand-written
    /// sample JSON one might test against tends to omit the milliseconds and therefore pass.
    ///
    /// Both forms are accepted rather than only the fractional one: `Prisma`/`pg` values round-trip
    /// through `toISOString()` today, but a timestamp that happens to land exactly on a second
    /// boundary is still serialised with `.000`, and other endpoints (or a future change) may not
    /// go through the same path. Accepting both costs one extra parse attempt on failure.
    public static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            if let date = iso8601WithFractionalSeconds.date(from: raw) { return date }
            if let date = iso8601Plain.date(from: raw) { return date }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Expected an ISO-8601 date, got \"\(raw)\""
            )
        }
        return decoder
    }()

    /// Encoder for request bodies. Dates go out in the same format they arrive in, so a value read
    /// from the server and sent back unchanged is byte-identical rather than subtly re-formatted.
    public static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(iso8601WithFractionalSeconds.string(from: date))
        }
        return encoder
    }()

    // `nonisolated(unsafe)` is accurate rather than a dodge: ISO8601DateFormatter is documented as
    // thread-safe for concurrent reads once configured, and these are configured once here and never
    // mutated. Creating a formatter per decode instead would be correct too, and measurably slower
    // on a 50-message page.
    nonisolated(unsafe) private static let iso8601WithFractionalSeconds: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    nonisolated(unsafe) private static let iso8601Plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}
