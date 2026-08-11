import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

/**
 * Stops one thrown render from becoming a blank screen.
 *
 * React unmounts the entire tree when a render throws and nothing catches it. In a single-page app
 * with no server-rendered fallback that means a white rectangle: no message, no navigation, no way
 * back short of knowing to reload. That is the same symptom as the app being down, which is a bad
 * thing for a bug in one panel to look like.
 *
 * Two deliberate choices:
 *
 * 1. **The error text is shown, not hidden.** The instinct is to show something reassuring and log
 *    the detail to a console — but the Android WebView's console goes to logcat, which nobody
 *    reading this screen on a phone can get at. Putting the message on screen behind a disclosure
 *    is the difference between a bug report that says "it broke" and one that can be acted on.
 *    Nothing here is privileged: it's this app's own stack trace, already readable in devtools on
 *    web, and the boundary is only reached on a crash.
 *
 * 2. **`resetKey` clears the error.** Without it a boundary latches forever — the user navigates to
 *    a working section and still sees the crash, because React has no reason to re-render a
 *    fallback that never changed. Callers pass whatever identifies "somewhere else" (a route, a
 *    section name), and the boundary recovers on its own.
 */
interface Props {
  children: ReactNode;
  /** Changing this clears a caught error — pass the current route/section. */
  resetKey?: string;
  /** What this boundary wraps, for the message ("this page" / "the owner console"). */
  label?: string;
  /** Root boundaries have nowhere to navigate to, so they only offer a reload. */
  variant?: "root" | "inline";
}

interface State {
  error: Error | null;
  info: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Still logged, for the platforms where a console is actually reachable.
    console.error("[ErrorBoundary]", error, info.componentStack);
    this.setState({ info: info.componentStack ?? null });
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, info: null });
    }
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const isRoot = this.props.variant === "root";
    const what = this.props.label ?? "This part of the app";

    return (
      <div
        className={
          isRoot
            ? "flex h-screen w-screen items-center justify-center bg-base-900 p-6 text-signal"
            : "flex min-h-0 flex-1 items-center justify-center p-6 text-signal"
        }
        role="alert"
      >
        <div className="w-full max-w-md rounded-xl border border-hairline bg-base-800 p-6 text-center">
          <AlertTriangle className="mx-auto mb-3 h-9 w-9 text-flare" />
          <h1 className="font-display text-lg">{what} stopped working</h1>
          <p className="mt-2 text-sm text-signal-dim">
            {isRoot
              ? "Reloading usually fixes it. If it keeps happening, the details below say why."
              : "The rest of the app is still fine — you can switch to something else, or reload."}
          </p>

          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            <RotateCw className="h-4 w-4" />
            Reload
          </button>

          <details className="mt-4 text-left">
            <summary className="cursor-pointer text-xs text-signal-faint hover:text-signal-dim">
              Technical details
            </summary>
            {/* Selectable and wrapped rather than clipped: the whole point is that someone can copy
                this out or screenshot it. */}
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-base-900 p-2 text-[11px] leading-relaxed text-signal-faint">
              {error.message}
              {info ? `\n${info}` : ""}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
