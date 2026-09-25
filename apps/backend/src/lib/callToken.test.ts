import { describe, expect, it } from "vitest";
import { DECLINE_TOKEN_TTL_SECONDS, signDeclineToken, verifyDeclineToken } from "./callToken.js";

const SECRET = "s".repeat(40);
const NOW = 1_800_000_000_000;

describe("call decline tokens", () => {
  it("round-trips to the user it was minted for", () => {
    const t = signDeclineToken(SECRET, "conv1", "user1", NOW);
    expect(verifyDeclineToken(SECRET, "conv1", t, NOW)).toBe("user1");
  });

  it("is bound to its conversation", () => {
    const t = signDeclineToken(SECRET, "conv1", "user1", NOW);
    expect(verifyDeclineToken(SECRET, "conv2", t, NOW)).toBeNull();
  });

  it("cannot be re-pointed at another user", () => {
    const [, exp, sig] = signDeclineToken(SECRET, "conv1", "user1", NOW).split(".");
    expect(verifyDeclineToken(SECRET, "conv1", `user2.${exp}.${sig}`, NOW)).toBeNull();
  });

  it("cannot have its expiry extended", () => {
    const [uid, exp, sig] = signDeclineToken(SECRET, "conv1", "user1", NOW).split(".");
    expect(verifyDeclineToken(SECRET, "conv1", `${uid}.${Number(exp) + 3600}.${sig}`, NOW)).toBeNull();
  });

  it("expires", () => {
    const t = signDeclineToken(SECRET, "conv1", "user1", NOW);
    expect(verifyDeclineToken(SECRET, "conv1", t, NOW + (DECLINE_TOKEN_TTL_SECONDS + 1) * 1000)).toBeNull();
  });

  it("rejects another secret and malformed input", () => {
    const t = signDeclineToken(SECRET, "conv1", "user1", NOW);
    expect(verifyDeclineToken("x".repeat(40), "conv1", t, NOW)).toBeNull();
    for (const bad of ["", "a.b", "a.b.c.d", "user1.notanumber.sig", "user1.99999999999.!!"]) {
      expect(verifyDeclineToken(SECRET, "conv1", bad, NOW)).toBeNull();
    }
  });
});
