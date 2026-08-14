import type { UserDTO } from "@lumina/shared";
import { pqSession, pqSeal, pqUnseal, pqInvalidate } from "./pqTransport";
import { useAuthStore } from "../store/authStore";
import { USES_BODY_REFRESH_TOKEN, CLIENT_TYPE } from "./platform";
import { getStoredRefreshToken, setStoredRefreshToken, clearStoredRefreshToken } from "./mobileRefreshToken";
import { getDeviceFingerprint } from "./deviceFingerprint";
import { useBanStore, type BanDetails } from "../store/banStore";

// Defaults to a relative "/api" so both the Vite dev-server proxy (see
// ../../vite.config.ts) and the production nginx same-origin setup (see
// ../../nginx.conf) work without any per-environment config. Override with
// VITE_API_BASE_URL if the API is ever served from a different origin (the mobile build always
// sets this to the absolute https://lumina.luxffa.com/api, since a Capacitor WebView has no
// same-origin dev-server/nginx proxy to ride along with).
const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api";

// Root-relative asset paths (User.avatarUrl = "/avatars/xyz", Attachment.url =
// "/api/files/xyz") are built server-side and resolve fine as-is on web (same-origin nginx
// setup) — but on mobile/desktop, the WebView's own origin (capacitor://localhost / app://
// bundle) shares nothing with the API's real origin, so a bare root-relative path silently
// resolves against the WRONG origin and 404s. Derived from API_BASE_URL rather than a separate
// env var so there's only one place that ever needs to know the API's real origin.
const ASSET_ORIGIN: string = API_BASE_URL.endsWith("/api") ? API_BASE_URL.slice(0, -"/api".length) : "";

export function resolveAssetUrl(path: string): string;
export function resolveAssetUrl(path: string | null): string | null;
export function resolveAssetUrl(path: string | null): string | null {
  if (!path) return path;
  return `${ASSET_ORIGIN}${path}`;
}

/**
 * GET /api/files/:id is membership-checked (see modules/uploads/routes.ts) but its URL is used
 * directly as `<img src>`/`<a href>` in MessageItem.tsx — browsers never attach a custom
 * `Authorization` header to native image/link loads, so the backend route accepts the SAME
 * access token as a `?token=` query param specifically for this case. Read imperatively
 * (`getState()`, not the `useAuthStore` hook) since this just needs the current value at
 * render/URL-construction time, not a live subscription — MessageItem renders once per message
 * in a list, and subscribing here would re-render every message on every token refresh.
 */
export function attachmentUrl(path: string): string {
  const base = resolveAssetUrl(path);
  const token = useAuthStore.getState().accessToken;
  if (!token) return base;
  return `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

interface TokenResponseBody {
  accessToken: string;
  refreshToken?: string; // present only for mobile clients (X-Client-Type: mobile)
  user: UserDTO;
}

async function persistMobileRefreshToken(data: TokenResponseBody): Promise<void> {
  if (USES_BODY_REFRESH_TOKEN && data.refreshToken) {
    await setStoredRefreshToken(data.refreshToken);
  }
}

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  isFormData?: boolean;
  // Internal: prevents infinite refresh loops.
  _isRetry?: boolean;
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Calls POST /api/auth/refresh using the httpOnly cookie. Returns true and
 * updates authStore on success, false (and clears authStore) on failure.
 * Coalesced so concurrent 401s only trigger one refresh call.
 */
async function refreshAccessToken(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const headers: Record<string, string> = {};
        let body: string | undefined;
        if (USES_BODY_REFRESH_TOKEN) {
          headers["X-Client-Type"] = CLIENT_TYPE!;
          headers["Content-Type"] = "application/json";
          const stored = await getStoredRefreshToken();
          if (!stored) {
            useAuthStore.getState().clear();
            return false;
          }
          body = JSON.stringify({ refreshToken: stored });
        }
        const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
          method: "POST",
          credentials: "include",
          headers,
          body,
        });
        if (!res.ok) {
          if (USES_BODY_REFRESH_TOKEN) await clearStoredRefreshToken();
          useAuthStore.getState().clear();
          return false;
        }
        const data = (await res.json()) as TokenResponseBody;
        await persistMobileRefreshToken(data);
        useAuthStore.getState().setSession(data.accessToken, data.user);
        return true;
      } catch {
        useAuthStore.getState().clear();
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

const TOKEN_ISSUING_PATHS = new Set(["/auth/login", "/auth/register"]);

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, isFormData = false, _isRetry = false } = options;

  const headers: Record<string, string> = {};
  const accessToken = useAuthStore.getState().accessToken;
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (body !== undefined && !isFormData) headers["Content-Type"] = "application/json";
  if (CLIENT_TYPE) headers["X-Client-Type"] = CLIENT_TYPE;
  // Only on the auth routes that create a session — that's where the backend records it against
  // the RefreshToken row. Sending it on every request would leak a tracking identifier to routes
  // with no use for it, and computing the fingerprint is not free.
  if (path === "/auth/login" || path === "/auth/register") {
    headers["X-Device-Fingerprint"] = getDeviceFingerprint();
  }

  // Mobile has no cookie carrying the refresh token, so /auth/logout must send it explicitly —
  // the backend reads it from the body (see readIncomingRefreshToken) to revoke the right row.
  let effectiveBody = body;
  if (USES_BODY_REFRESH_TOKEN && path === "/auth/logout") {
    const stored = await getStoredRefreshToken();
    effectiveBody = { ...(body as Record<string, unknown> | undefined), refreshToken: stored };
    headers["Content-Type"] = "application/json";
  }

  // ---- post-quantum transport (best-effort; see lib/pqTransport.ts) ----------------------------
  // Sealed only when: the shield is available, this is a JSON (not multipart) call, and it is not
  // a PQ handshake route itself. Multipart uploads keep their own framing; the handshake must be
  // in the clear to bootstrap. A failed handshake silently means plain JSON over TLS.
  const pqEligible = !isFormData && !path.startsWith("/pq/");
  const pq = pqEligible ? await pqSession(API_BASE_URL) : null;

  let fetchBody: BodyInit | undefined;
  if (effectiveBody === undefined) {
    fetchBody = undefined;
  } else if (isFormData) {
    fetchBody = effectiveBody as FormData;
  } else if (pq) {
    fetchBody = pqSeal(pq, JSON.stringify(effectiveBody)) as unknown as BodyInit;
    headers["Content-Type"] = "application/x-lumina-pq";
    headers["X-PQ-Session"] = pq.sessionId;
  } else {
    fetchBody = JSON.stringify(effectiveBody);
  }
  // A GET/DELETE with no body still wants the shield on its RESPONSE — carry the session header.
  if (pq && effectiveBody === undefined) headers["X-PQ-Session"] = pq.sessionId;

  let res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    credentials: "include",
    body: fetchBody,
  });

  // The session lapsed (traffic-key rotation): drop it, re-handshake, and retry ONCE in the clear
  // path so the caller never sees a 428. This is the rotation working, not an error.
  if (res.status === 428 && pqEligible) {
    pqInvalidate();
    const retryHeaders = { ...headers };
    delete retryHeaders["X-PQ-Session"];
    const fresh = await pqSession(API_BASE_URL);
    if (fresh && !isFormData && effectiveBody !== undefined) {
      retryHeaders["Content-Type"] = "application/x-lumina-pq";
      retryHeaders["X-PQ-Session"] = fresh.sessionId;
      res = await fetch(`${API_BASE_URL}${path}`, { method, headers: retryHeaders, credentials: "include", body: pqSeal(fresh, JSON.stringify(effectiveBody)) as unknown as BodyInit });
    } else if (fresh) {
      retryHeaders["X-PQ-Session"] = fresh.sessionId;
      res = await fetch(`${API_BASE_URL}${path}`, { method, headers: retryHeaders, credentials: "include", body: fetchBody });
    } else {
      // Shield unavailable now — plain retry so the request still succeeds.
      delete retryHeaders["Content-Type"];
      if (!isFormData && effectiveBody !== undefined) retryHeaders["Content-Type"] = "application/json";
      res = await fetch(`${API_BASE_URL}${path}`, { method, headers: retryHeaders, credentials: "include", body: effectiveBody === undefined ? undefined : isFormData ? (effectiveBody as FormData) : JSON.stringify(effectiveBody) });
    }
  }

  // If the response came back sealed, transparently unseal it into a normal JSON-bearing Response
  // so every line below this is untouched.
  if (pq && res.headers.get("x-pq") === "1") {
    const sealedBuf = new Uint8Array(await res.arrayBuffer());
    let plain = "";
    try {
      plain = pqUnseal(pq, sealedBuf);
    } catch {
      plain = "";
    }
    res = new Response(plain, { status: res.status, statusText: res.statusText, headers: { "content-type": "application/json" } });
  }

  if (USES_BODY_REFRESH_TOKEN && path === "/auth/logout" && res.ok) {
    await clearStoredRefreshToken();
  }

  if (res.status === 401 && !_isRetry && path !== "/auth/refresh" && path !== "/auth/login") {
    let code: string | undefined;
    try {
      const cloned = await res.clone().json();
      code = cloned?.code;
    } catch {
      /* not json */
    }
    if (code === "UNAUTHORIZED") {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        return apiRequest<T>(path, { ...options, _isRetry: true });
      }
      if (typeof window !== "undefined" && window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
  }

  if (!res.ok) {
    let message = res.statusText;
    let code: string | undefined;
    let details: unknown;
    try {
      const data = await res.json();
      message = data?.error ?? message;
      code = data?.code;
      details = data?.details;
    } catch {
      /* body wasn't json */
    }
    // A platform ban is routed to a single global screen rather than surfaced as an error toast on
    // whichever call happened to hit it — it can arrive from a login attempt or mid-session on any
    // authenticated request, and both need the same explanation and appeal route.
    if (code === "PLATFORM_BANNED") {
      useBanStore.getState().setBan(details as BanDetails);
    }
    throw new ApiError(res.status, message, code, details);
  }

  if (res.status === 204) return undefined as T;
  const data = await res.json();
  if (USES_BODY_REFRESH_TOKEN && TOKEN_ISSUING_PATHS.has(path)) {
    await persistMobileRefreshToken(data as TokenResponseBody);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => apiRequest<T>(path, { method: "GET" }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "POST", body: body ?? {} }),
  postForm: <T>(path: string, form: FormData) => apiRequest<T>(path, { method: "POST", body: form, isFormData: true }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "PATCH", body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "PUT", body: body ?? {} }),
  delete: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "DELETE", body }),
};

export async function silentRefresh(): Promise<boolean> {
  return refreshAccessToken();
}
