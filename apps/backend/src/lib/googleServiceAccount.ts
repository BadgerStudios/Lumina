import crypto from "node:crypto";
import fs from "node:fs";

/**
 * A Google service account, used to mint OAuth access tokens with node:crypto alone (no SDK) - the
 * same approach as lib/fcm.ts. Used for the Play Console report bucket (Cloud Storage).
 */
export interface GoogleServiceAccount {
  project_id?: string;
  client_email: string;
  private_key: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Accepts raw JSON or base64-encoded JSON (a .env can't carry a PEM's newlines). null if unusable. */
export function parseServiceAccount(raw: string | undefined | null): GoogleServiceAccount | null {
  if (!raw?.trim()) return null;
  try {
    const trimmed = raw.trim();
    // Raw JSON, a path to the JSON file, or base64 of the JSON.
    const text = trimmed.startsWith("{")
      ? trimmed
      : trimmed.startsWith("/") && fs.existsSync(trimmed)
        ? fs.readFileSync(trimmed, "utf8")
        : Buffer.from(trimmed, "base64").toString("utf8");
    const parsed = JSON.parse(text) as Partial<GoogleServiceAccount>;
    if (!parsed.client_email || !parsed.private_key) return null;
    return parsed as GoogleServiceAccount;
  } catch {
    return null;
  }
}

const cache = new Map<string, { value: string; expiresAt: number }>();

/** A bearer token for `scope`, cached until a minute before expiry. null on any failure (logged). */
export async function googleAccessToken(account: GoogleServiceAccount, scope: string): Promise<string | null> {
  const key = `${account.client_email}|${scope}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.value;

  const now = Math.floor(Date.now() / 1000);
  const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");
  const signingInput = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(
    JSON.stringify({ iss: account.client_email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
  )}`;
  const privateKey = account.private_key.includes("\\n") ? account.private_key.replace(/\\n/g, "\n") : account.private_key;
  try {
    const signature = b64(crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey));
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${signingInput}.${signature}` }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) {
      // eslint-disable-next-line no-console
      console.error(`[google] token exchange failed for ${account.client_email} (${res.status})`);
      return null;
    }
    cache.set(key, { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[google] token exchange error:", (err as Error)?.message);
    return null;
  }
}
