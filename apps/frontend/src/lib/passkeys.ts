import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api } from "./apiClient";
import type { UserDTO } from "@lumina/shared";

/**
 * Passkey (biometric) sign-in.
 *
 * Face ID on the iPhone home-screen app, fingerprint on Android Chrome, Windows Hello or Touch ID
 * on desktop. Nothing biometric ever leaves the device — the fingerprint unlocks a private key held
 * in the device's secure hardware, and only a signature crosses the network.
 */

export interface PasskeySummary {
  id: string;
  label: string | null;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * Whether this browser can do platform (biometric) authentication *right now*.
 *
 * Two separate questions, and both matter. `window.PublicKeyCredential` says the API exists;
 * `isUserVerifyingPlatformAuthenticatorAvailable()` says there is actually a fingerprint reader,
 * face scanner or PIN configured. A desktop Chrome with no Windows Hello set up passes the first
 * and fails the second — offering the button there produces a dialog the user cannot complete.
 */
export async function isPasskeySupported(): Promise<boolean> {
  if (typeof window === "undefined" || !window.PublicKeyCredential) return false;
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/**
 * Whether a passkey is even usable on this build.
 *
 * The Capacitor Android apps load from `capacitor://localhost` (or `https://localhost`), and
 * WebAuthn scopes every credential to the registrable domain of the page's origin. That origin can
 * never match `lumina.badgerstudios.net`, so the browser refuses the credential — not a bug to fix
 * but a property of the standard. The packaged apps need a native BiometricPrompt instead, which is
 * a separate piece of work.
 */
export function passkeysUsableHere(): boolean {
  if (typeof window === "undefined") return false;
  const { protocol, hostname } = window.location;
  if (protocol === "capacitor:" || protocol === "file:") return false;
  // WebAuthn requires a secure context; localhost counts as one for development.
  return protocol === "https:" || hostname === "localhost" || hostname === "127.0.0.1";
}

/** Enrols a new passkey for the signed-in account. */
export async function registerPasskey(label?: string): Promise<void> {
  const options = await api.post<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
    "/auth/passkeys/begin",
  );
  const response = await startRegistration({ optionsJSON: options });
  await api.post("/auth/passkeys/finish", { response, label });
}

interface AuthResponse {
  accessToken: string;
  user: UserDTO;
}

/**
 * Signs in with a passkey, with no username typed.
 *
 * The browser offers whichever credentials it holds for this domain, so the whole flow is: tap the
 * button, look at the phone. That is the version of this feature worth having — a passkey flow that
 * still demands a username first is barely faster than typing a password.
 */
export async function signInWithPasskey(): Promise<AuthResponse> {
  const { handle, options } = await api.post<{
    handle: string;
    options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
  }>("/auth/passkeys/login/begin");

  const response = await startAuthentication({ optionsJSON: options });
  return api.post<AuthResponse>("/auth/passkeys/login/finish", { handle, response });
}

export function listPasskeys(): Promise<PasskeySummary[]> {
  return api.get<PasskeySummary[]>("/auth/passkeys");
}

export function deletePasskey(id: string): Promise<void> {
  return api.delete<void>(`/auth/passkeys/${encodeURIComponent(id)}`);
}

/**
 * Turns a WebAuthn failure into something worth showing.
 *
 * The spec funnels almost everything into `NotAllowedError`, which covers both "the user cancelled"
 * and "it timed out" — and telling someone their deliberate cancel was an error is worse than
 * saying nothing, so that case returns null and the caller stays quiet.
 */
export function passkeyErrorMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return "Couldn't use a passkey.";
  if (error.name === "NotAllowedError") return null;
  if (error.name === "InvalidStateError") return "This device already has a passkey for your account.";
  if (error.name === "NotSupportedError") return "This device can't create passkeys.";
  if (error.name === "SecurityError") return "Passkeys need a secure (https) connection.";
  return error.message || "Couldn't use a passkey.";
}
