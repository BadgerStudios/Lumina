/**
 * A component that throws, so the error boundary can be tested against a real React crash rather
 * than assumed to work.
 *
 * An untested error boundary is worth very little: the failure mode is that it silently doesn't
 * catch (wrong position in the tree, an error thrown from an event handler or an async callback
 * where boundaries don't apply at all), and you find out during the outage it was meant to soften.
 *
 * Only mounted behind `import.meta.env.DEV`. Vite replaces that with a literal `false` in a
 * production build and the bundler drops the branch, so this never reaches a shipped app — asserted
 * in verify-error-boundary.mjs by grepping the built bundle for the marker below.
 */
export const CRASH_MARKER = "lumina-crash-test-component";

export function CrashTest(): never {
  throw new Error(`Deliberate crash from ${CRASH_MARKER}`);
}
