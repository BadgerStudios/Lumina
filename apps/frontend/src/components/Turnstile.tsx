import { useCallback, useEffect, useRef, useState } from "react";
import { useVerificationConfig } from "../queries/verification";

/**
 * Cloudflare Turnstile widget.
 *
 * Renders the challenge and hands the solved token up via `onToken`. When the server reports no site
 * key (Turnstile unconfigured — the default), this renders nothing and the surrounding form submits
 * unchallenged, exactly matching the server's `requireTurnstile` no-op. So a page can always include
 * `<Turnstile onToken={setToken} />` unconditionally; it lights up the moment the key is set.
 *
 * The Cloudflare script (challenges.cloudflare.com/turnstile/v0/api.js) is loaded dynamically the
 * first time a widget mounts — it must NOT be an inline script (the production CSP forbids those) and
 * challenges.cloudflare.com is allowlisted in csp.conf.
 */

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: TurnstileOptions) => string;
      remove: (id: string) => void;
      reset: (id?: string) => void;
    };
    __turnstileLoading?: Promise<void>;
  }
}

interface TurnstileOptions {
  sitekey: string;
  callback: (token: string) => void;
  "error-callback"?: () => void;
  "expired-callback"?: () => void;
  action?: string;
  theme?: "auto" | "light" | "dark";
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (window.__turnstileLoading) return window.__turnstileLoading;
  const loading = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Turnstile"));
    document.head.appendChild(s);
  });
  // Drop the cached promise on failure, otherwise every later Retry replays the same rejection and
  // the user can never recover from a transient block.
  window.__turnstileLoading = loading.catch((err) => {
    window.__turnstileLoading = undefined;
    throw err;
  });
  return window.__turnstileLoading;
}

export function Turnstile({ onToken, action }: { onToken: (token: string) => void; action?: string }) {
  const { data: config } = useVerificationConfig();
  const siteKey = config?.turnstileSiteKey ?? null;
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  /*
   * `onToken` is held in a ref and deliberately kept OUT of the render effect's dependencies.
   *
   * It used to be a dependency, and the effect's cleanup calls `window.turnstile.remove()`. So any
   * caller passing an inline arrow — a new function identity on every render — tore the widget down
   * and built a new one on every parent render. Two of the four call sites did exactly that
   * (TurnstileChallengeModal, and Register), which on the sign-up form meant the challenge was
   * destroyed and recreated on EVERY KEYSTROKE: a visibly flickering captcha on the one screen where
   * a broken challenge means nobody can create an account.
   *
   * Fixing it here rather than at the call sites is the point: the component should not be
   * detonated by an ordinary React idiom, and a future caller cannot reintroduce the bug.
   */
  const onTokenRef = useRef(onToken);
  useEffect(() => {
    onTokenRef.current = onToken;
  });

  const retry = useCallback(() => {
    setFailed(false);
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;
    let cancelled = false;
    const el = containerRef.current;

    void loadTurnstileScript()
      .then(() => {
        if (cancelled || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(el, {
          sitekey: siteKey,
          callback: (token) => {
            if (cancelled) return;
            setFailed(false);
            onTokenRef.current(token);
          },
          "expired-callback": () => {
            if (!cancelled) onTokenRef.current("");
          },
          "error-callback": () => {
            if (cancelled) return;
            onTokenRef.current("");
            setFailed(true);
          },
          ...(action ? { action } : {}),
          theme: "auto",
        });
      })
      .catch(() => {
        // The script is blocked (ad/tracker blocker, DNS filter, offline) or the widget refused this
        // origin. This used to be swallowed on the belief that the server fails open - it does not:
        // requireTurnstile throws TURNSTILE_REQUIRED the moment a token is MISSING, and only falls
        // open when it HAS a token and cannot reach siteverify. So a silent failure here became a
        // bare "Access denied" with nothing to act on. Say so, and offer a retry.
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          /* already gone */
        }
        widgetIdRef.current = null;
      }
    };
    // `attempt` is the retry trigger: bumping it tears the widget down and mounts a fresh one.
    // `onToken` is intentionally absent — see onTokenRef above. Adding it back reintroduces a
    // remount-per-render on any caller that passes an inline function.
  }, [siteKey, action, attempt]);

  if (!siteKey) return null;

  return (
    <div className="flex flex-col items-center gap-2">
      <div ref={containerRef} className={failed ? "hidden" : "flex justify-center"} />
      {failed && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-center text-xs text-signal-dim">
          <p className="font-semibold text-signal">Security check couldn't load</p>
          <p className="mt-1">
            An ad blocker, privacy extension or network filter is usually the cause. Allow{" "}
            <span className="font-mono">challenges.cloudflare.com</span> and try again.
          </p>
          <button type="button" onClick={retry} className="mt-2 font-semibold text-accent hover:underline">
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
