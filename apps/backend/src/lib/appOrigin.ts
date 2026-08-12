import { env } from "../config/env.js";

/**
 * The single canonical origin for links Lumina puts in front of a user.
 *
 * ## Why this needs a helper at all
 *
 * `PUBLIC_APP_URL` is set from `CORS_ORIGIN` in `compose.yml`, which is a **comma-separated list**
 * of every origin this instance answers on:
 *
 *     https://lumina.badgerstudios.net,https://lumina.luxffa.com,https://localhost,capacitor://localhost,app://bundle
 *
 * Interpolating that straight into a URL produces something that is not a URL, and — this is the
 * dangerous part — nothing throws. `new URL()` parses the whole string into a hostname of
 * `lumina.badgerstudios.net,https`, and string concatenation happily yields
 * `https://a,https://b,app://bundle/settings/billing`. The failure surfaces far away from the cause:
 * as a WebAuthn "RP ID is invalid for this domain" in the browser, or as a rejected Stripe redirect.
 *
 * Three call sites derived this independently before it was shared: the passkey relying party, the
 * email verification link, and Stripe's redirect URLs. The third got it wrong, which is what this
 * module exists to stop happening a fourth time.
 *
 * ## The selection rule
 *
 * The first `https://` non-localhost entry is the canonical public origin. `localhost`,
 * `capacitor://` and `app://` entries exist for local dev and the native shells — they are valid
 * CORS origins but can never be somewhere a user clicks a link to.
 */
export function primaryAppOrigin(): string {
  const origins = env.PUBLIC_APP_URL.split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  return origins.find((o) => o.startsWith("https://") && !o.includes("localhost")) ?? origins[0] ?? "";
}
