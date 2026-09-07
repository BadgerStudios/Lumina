import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { MEDIA_COOKIE_NAME, extractMediaUserId } from "./mediaAuth.js";
import { signAccessToken } from "./jwt.js";
import { UnauthorizedError } from "./errors.js";

// Only the three fields extractMediaUserId reads. Anything else on a real request is irrelevant
// to which credential wins, which is the whole thing under test.
function req(parts: { auth?: string; query?: Record<string, string>; cookies?: Record<string, string> }): FastifyRequest {
  return {
    headers: parts.auth ? { authorization: parts.auth } : {},
    query: parts.query ?? {},
    cookies: parts.cookies ?? {},
  } as unknown as FastifyRequest;
}

describe("extractMediaUserId", () => {
  const alice = signAccessToken("user-alice");
  const bob = signAccessToken("user-bob");

  it("accepts each of the three sources on its own", () => {
    expect(extractMediaUserId(req({ auth: `Bearer ${alice}` }))).toBe("user-alice");
    expect(extractMediaUserId(req({ query: { token: alice } }))).toBe("user-alice");
    expect(extractMediaUserId(req({ cookies: { [MEDIA_COOKIE_NAME]: alice } }))).toBe("user-alice");
  });

  it("prefers the header, then the query param, then the cookie", () => {
    // An older cached web bundle still appends ?token= while the browser also holds the new
    // cookie — the URL must keep winning so that bundle behaves exactly as it did before.
    expect(extractMediaUserId(req({ query: { token: alice }, cookies: { [MEDIA_COOKIE_NAME]: bob } }))).toBe("user-alice");
    expect(extractMediaUserId(req({ auth: `Bearer ${bob}`, query: { token: alice } }))).toBe("user-bob");
  });

  it("ignores every other cookie", () => {
    expect(() => extractMediaUserId(req({ cookies: { lumina_refresh: alice, session: alice } }))).toThrow(UnauthorizedError);
  });

  it("rejects a bad credential rather than falling through to a good one", () => {
    // A garbage query token with a valid cookie is "invalid", not "use the cookie instead" — the
    // caller sent something specific and wrong.
    expect(() => extractMediaUserId(req({ query: { token: "not-a-jwt" }, cookies: { [MEDIA_COOKIE_NAME]: alice } }))).toThrow(
      /Invalid or expired/,
    );
    expect(() => extractMediaUserId(req({}))).toThrow(/Missing access token/);
  });
});
