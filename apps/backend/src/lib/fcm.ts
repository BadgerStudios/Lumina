import crypto from "node:crypto";
import { env } from "../config/env.js";
import { channelIdFor, DEFAULT_TONES, type DeviceTones, type PushKind } from "@lumina/shared";

/**
 * Firebase Cloud Messaging, for notifications the phone itself renders.
 *
 * ## Why this exists alongside web push
 *
 * Web push already reaches every browser and the Capacitor WebView, and for most purposes that is
 * enough. What it cannot do is control the sound: Chrome dropped `Notification.sound`, so a web
 * push on Android always plays the system tone no matter what the payload says. A notification
 * channel can carry a sound resource, and only FCM can address one.
 *
 * So the two are not alternatives. A device with an FCM token gets the native notification, with
 * the app's own sound and mark; everything else continues to get web push exactly as before.
 *
 * ## No SDK
 *
 * firebase-admin is a large dependency for two HTTP calls. The service-account flow is a signed
 * JWT exchanged for an access token, which node:crypto already does — the same reasoning as the
 * hand-written Didit client. Nothing throws at import time and every call is a no-op when
 * unconfigured, so the build and the tests run with no Firebase credentials at all.
 *
 * ## Configuring it
 *
 * FCM_SERVICE_ACCOUNT_JSON takes the service-account key file, either as raw JSON or base64 of it.
 * Base64 is usually easier: the private key contains newlines, which a .env line does not carry.
 */

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

let cached: ServiceAccount | null | undefined;

/** Parsed once. `null` means configured-but-unusable, which is different from absent. */
function serviceAccount(): ServiceAccount | null {
  if (cached !== undefined) return cached;
  const raw = env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw?.trim()) {
    cached = null;
    return cached;
  }
  try {
    // Accept base64 as well as raw JSON: a PEM private key has newlines in it, and a .env file has
    // no way to carry those, so base64 is what anyone will actually end up pasting.
    const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(text) as Partial<ServiceAccount>;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      // eslint-disable-next-line no-console
      console.error("[fcm] service account is missing project_id, client_email or private_key");
      cached = null;
      return cached;
    }
    cached = parsed as ServiceAccount;
  } catch {
    // eslint-disable-next-line no-console
    console.error("[fcm] FCM_SERVICE_ACCOUNT_JSON is neither JSON nor base64-encoded JSON");
    cached = null;
  }
  return cached;
}

export function isFcmConfigured(): boolean {
  return serviceAccount() !== null;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

let accessToken: { value: string; expiresAt: number } | null = null;

/**
 * A bearer token for the messaging API.
 *
 * Cached until a minute before it expires. Minting one costs a signature and a round trip, and
 * doing that per notification would make a fan-out to twenty devices twenty-one requests.
 */
async function getAccessToken(): Promise<string | null> {
  const account = serviceAccount();
  if (!account) return null;
  if (accessToken && accessToken.expiresAt > Date.now() + 60_000) return accessToken.value;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  // The key arrives with literal \n when it has been through a .env, and with real newlines when it
  // came from base64. Normalising covers both rather than working for only one of them.
  const privateKey = account.private_key.includes("\\n")
    ? account.private_key.replace(/\\n/g, "\n")
    : account.private_key;

  let signature: string;
  try {
    signature = base64url(crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[fcm] could not sign with the service-account key:", (err as Error)?.message);
    return null;
  }

  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${signingInput}.${signature}`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) {
      // eslint-disable-next-line no-console
      console.error(`[fcm] token exchange failed (${res.status})`);
      return null;
    }
    accessToken = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return accessToken.value;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[fcm] token exchange error:", (err as Error)?.message);
    return null;
  }
}

export interface FcmMessage {
  title: string;
  body: string;
  /** Deep link the tap should open, handed to the app as data rather than acted on by the system. */
  url: string;
  /** Collapses repeats into one notification per subject, the same way the web push `tag` does. */
  tag?: string;
  /** Which of the person's tones this plays, and therefore which channel it names. Default "message". */
  kind?: PushKind;
  /** Store-and-forward lifetime; see PushPayload.ttlSeconds. */
  ttlSeconds?: number;
}


/**
 * Deliver to one device.
 *
 * Returns false when the token is dead, so the caller can prune it — a device that has uninstalled
 * or reset its token otherwise stays in the table forever and is retried on every notification.
 */
export async function sendFcmToToken(token: string, message: FcmMessage, tones: DeviceTones = DEFAULT_TONES): Promise<boolean> {
  const account = serviceAccount();
  if (!account) return true; // not configured: nothing was attempted, nothing to prune
  const bearer = await getAccessToken();
  if (!bearer) return true;

  const kind: PushKind = message.kind ?? "message";
  const sound = tones[kind];
  const channel = channelIdFor(kind, sound);
  try {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: message.title, body: message.body },
          data: { url: message.url },
          android: {
            // Doze batches NORMAL messages until the device next wakes, which for a phone in a
            // pocket can be hours — a friend request or a call arriving that evening reads as
            // "notifications are broken". Every push here draws a notification the person sees,
            // which is the one condition Google attaches to HIGH, so everything is HIGH; what is
            // rate-limited is high-priority pushes that never surface anything.
            priority: "HIGH",
            ttl: `${Math.max(0, Math.round(message.ttlSeconds ?? 86_400))}s`,
            // Collapsing happens server-side too, so a phone that was off does not wake to forty
            // separate notifications from one conversation.
            ...(message.tag ? { collapse_key: message.tag } : {}),
            notification: {
              channel_id: channel,
              // Pre-Android-8 devices have no channels, so the sound has to be named here as well.
              // On 8+ this is ignored and the channel's own sound is used.
              sound,
              ...(message.tag ? { tag: message.tag } : {}),
              icon: "ic_stat_notify",
              color: "#5b7cfa",
            },
          },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok) return true;
    const body = (await res.json().catch(() => ({}))) as { error?: { status?: string } };
    const status = body.error?.status;
    // UNREGISTERED / INVALID_ARGUMENT on a token mean it will never work again.
    if (res.status === 404 || status === "UNREGISTERED" || status === "NOT_FOUND") return false;
    // eslint-disable-next-line no-console
    console.error(`[fcm] send failed (${res.status} ${status ?? ""})`);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[fcm] send error:", (err as Error)?.message);
    return true;
  }
}
