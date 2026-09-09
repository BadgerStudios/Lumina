/**
 * Carrying "where I was going" through a sign-in.
 *
 * Someone who opens an invite while logged out has to log in first, and before
 * this the invite was simply lost: both auth screens navigated to "/" and the
 * links carried nothing. Now the destination rides along in ?next=.
 *
 * Only an in-app path is ever honoured. Anything absolute, protocol-relative, or
 * otherwise not starting with a single "/" is discarded rather than followed,
 * so a crafted link cannot use our own login page to bounce someone off-site.
 */
const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9/_\-.~%?&=:@+]*$/;

export function isSafeReturnPath(path: string | null | undefined): boolean {
  return typeof path === "string" && path.length > 0 && path.length <= 512 && SAFE_PATH.test(path);
}

/** `?next=<path>` for a link into the auth screens, or "" when there is nowhere to return to. */
export function returnToQuery(path: string | null | undefined): string {
  return isSafeReturnPath(path) ? `?next=${encodeURIComponent(path!)}` : "";
}

/** Where to land after signing in: the requested path when it is safe, else `fallback`. */
export function returnToTarget(search: string, fallback: string): string {
  const next = new URLSearchParams(search).get("next");
  return isSafeReturnPath(next) ? next! : fallback;
}
