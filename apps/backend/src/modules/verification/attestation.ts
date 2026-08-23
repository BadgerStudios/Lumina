import crypto from "node:crypto";
import fs from "node:fs";
import { env } from "../../config/env.js";

/**
 * Device attestation — proves a native age-band submission came from the genuine, unmodified app on a
 * genuine device, not a repackaged clone or a script hitting the endpoint. Without this a native
 * "18+" band is trivially forgeable, so the rule is strict and FAIL-CLOSED: if attestation cannot be
 * verified for a platform, we return false and the caller does NOT upgrade the account's assurance —
 * the band is ignored and the account stays at its self-declared level. Trusting an unverified band
 * would be strictly worse than the self-declared status quo.
 *
 * Android: Google Play Integrity API (implemented).
 * iOS:     Apple App Attest (fail-closed stub until the iOS app ships — see note on verifyAppAttest).
 */

export type AttestationPlatform = "android" | "ios";

export async function verifyDeviceAttestation(
  platform: AttestationPlatform,
  token: string | undefined,
): Promise<boolean> {
  if (!token) return false;
  try {
    if (platform === "android") return await verifyPlayIntegrity(token);
    if (platform === "ios") return await verifyAppAttest(token);
  } catch {
    // Any failure verifying is a failure to trust. Never let an exception fall through to "trusted".
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------
// Android — Play Integrity
// ---------------------------------------------------------------------------------------------------

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

function loadServiceAccount(): ServiceAccount | null {
  const raw = env.GOOGLE_PLAY_INTEGRITY_SA_JSON;
  if (!raw) return null;
  try {
    // Accept either inline JSON or a path to a JSON file.
    const text = raw.trim().startsWith("{") ? raw : fs.readFileSync(raw, "utf8");
    const sa = JSON.parse(text) as ServiceAccount;
    return sa.client_email && sa.private_key ? sa : null;
  } catch {
    return null;
  }
}

/** Mint a short-lived Google OAuth access token from the service account (JWT-bearer grant). */
async function googleAccessToken(sa: ServiceAccount, scope: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(`${header}.${claim}`)
    .sign(sa.private_key.replace(/\\n/g, "\n"));
  const assertion = `${header}.${claim}.${b64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body = (await res.json()) as { access_token?: string };
  if (!res.ok || !body.access_token) throw new Error("Google token exchange failed");
  return body.access_token;
}

async function verifyPlayIntegrity(token: string): Promise<boolean> {
  const pkg = env.GOOGLE_PLAY_PACKAGE_NAME;
  const sa = loadServiceAccount();
  if (!pkg || !sa) return false; // fail closed — not configured

  const accessToken = await googleAccessToken(sa, "https://www.googleapis.com/auth/playintegrity");
  const res = await fetch(
    `https://playintegrity.googleapis.com/v1/${encodeURIComponent(pkg)}:decodeIntegrityToken`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ integrity_token: token }),
    },
  );
  if (!res.ok) return false;
  const payload = (await res.json()) as {
    tokenPayloadExternal?: {
      appIntegrity?: { appRecognitionVerdict?: string; packageName?: string };
      deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
    };
  };
  const external = payload.tokenPayloadExternal;
  if (!external) return false;

  const appOk =
    external.appIntegrity?.appRecognitionVerdict === "PLAY_RECOGNIZED" &&
    external.appIntegrity?.packageName === pkg;
  const deviceOk = (external.deviceIntegrity?.deviceRecognitionVerdict ?? []).includes(
    "MEETS_DEVICE_INTEGRITY",
  );
  return Boolean(appOk && deviceOk);
}

// ---------------------------------------------------------------------------------------------------
// iOS — App Attest
// ---------------------------------------------------------------------------------------------------

/**
 * FAIL-CLOSED STUB. Full App Attest verification (parse the CBOR attestation object, validate the
 * certificate chain to Apple's App Attest root CA, check the nonce and the app id hash) is a
 * meaningful amount of code and is only exercisable once the iOS app exists and can produce real
 * attestations. Until then this returns false, so the iOS DEVICE_DECLARED path is inert — exactly the
 * safe default. This is the piece to complete when the Capacitor iOS target ships. See plan.
 */
async function verifyAppAttest(_token: string): Promise<boolean> {
  if (!env.APPLE_APP_ATTEST_TEAM_ID || !env.APPLE_APP_ATTEST_BUNDLE_ID) return false;
  // Deliberately not yet trusting App Attest — return false until full chain verification lands.
  return false;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
