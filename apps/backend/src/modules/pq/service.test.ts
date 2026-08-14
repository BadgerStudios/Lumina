import { describe, expect, it } from "vitest";
import { createHash, hkdfSync } from "node:crypto";
import { seal, unseal } from "./service.js";

/**
 * Pure sealing invariants. The DB/Redis-touching parts (rotation, session establishment) are
 * exercised by the live verify-pq suite against a real deployment; here we prove the symmetric
 * envelope itself, which is the part a bug would silently corrupt.
 */
describe("PQ seal/unseal", () => {
  const key = createHash("sha256").update("test-key").digest();

  it("round-trips arbitrary payloads", () => {
    for (const s of ["", "hi", JSON.stringify({ a: 1, b: [2, 3], c: "über 🔐" }), "x".repeat(100_000)]) {
      const out = unseal(key, seal(key, Buffer.from(s)));
      expect(out.toString("utf8")).toBe(s);
    }
  });

  it("uses a fresh nonce every time (no deterministic ciphertext)", () => {
    const a = seal(key, Buffer.from("same"));
    const b = seal(key, Buffer.from("same"));
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it("rejects a tampered ciphertext (AEAD authentication)", () => {
    const sealed = seal(key, Buffer.from("secret"));
    sealed[sealed.length - 1] ^= 0xff; // flip a byte in the tag/ciphertext
    expect(() => unseal(key, sealed)).toThrow();
  });

  it("rejects the wrong key", () => {
    const sealed = seal(key, Buffer.from("secret"));
    const otherKey = createHash("sha256").update("other-key").digest();
    expect(() => unseal(otherKey, sealed)).toThrow();
  });

  it("direction separation: a c2s-sealed blob does not open with the s2c key", () => {
    const hybrid = createHash("sha256").update("shared").digest();
    const salt = Buffer.from("lumina-pq-v1");
    const c2s = Buffer.from(hkdfSync("sha256", hybrid, salt, "c2s:kid", 32));
    const s2c = Buffer.from(hkdfSync("sha256", hybrid, salt, "s2c:kid", 32));
    const sealed = seal(c2s, Buffer.from("client says hi"));
    expect(() => unseal(s2c, sealed)).toThrow(); // can't replay a request as a response
  });
});
