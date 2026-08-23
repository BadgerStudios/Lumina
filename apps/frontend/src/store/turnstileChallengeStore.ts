import { create } from "zustand";

/**
 * Imperative bridge for an on-demand Turnstile challenge. The apiClient (not a React component) calls
 * `request()` when the server answers a protected call with reasonCode TURNSTILE_REQUIRED; the
 * TurnstileChallengeModal (mounted once at the app root) shows the widget and calls `complete(token)`
 * when it's solved (or `complete(null)` if the user dismisses it). One shared pending promise, so
 * concurrent challenged requests all wait on the same modal rather than stacking widgets.
 */

let pending: Promise<string | null> | null = null;
let resolver: ((token: string | null) => void) | null = null;
let timeoutId: ReturnType<typeof setTimeout> | null = null;

// Safety valve: if the widget never solves and the user never cancels (e.g. it failed to render, or
// the tab was backgrounded), resolve null so the awaiting request throws cleanly instead of hanging
// forever. Generous — real users solving an interactive challenge take a few seconds, not minutes.
const CHALLENGE_TIMEOUT_MS = 120_000;

interface TurnstileChallengeState {
  active: boolean;
  request: () => Promise<string | null>;
  complete: (token: string | null) => void;
}

export const useTurnstileChallenge = create<TurnstileChallengeState>((set, get) => ({
  active: false,
  request: () => {
    if (pending) return pending;
    pending = new Promise<string | null>((resolve) => {
      resolver = resolve;
    });
    timeoutId = setTimeout(() => get().complete(null), CHALLENGE_TIMEOUT_MS);
    set({ active: true });
    return pending;
  },
  complete: (token) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    const r = resolver;
    resolver = null;
    pending = null;
    set({ active: false });
    r?.(token);
  },
}));

/** Imperative entry point for the apiClient. */
export function requestTurnstileToken(): Promise<string | null> {
  return useTurnstileChallenge.getState().request();
}
