import { describe, expect, it, beforeAll } from "vitest";
import { ENCRYPTION_MODES, cryptoReady, decryptRtp, encryptRtp, ipDiscoveryReply, newSecretKey, parseIpDiscovery, rtpClearHeaderLength, rtpHeader } from "./crypto.js";

beforeAll(() => cryptoReady());

describe("voice packet encryption", () => {
  const key = newSecretKey();
  const opus = Buffer.from([0xfc, 0xff, 0xfe, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  it("round-trips an opus frame in every mode", () => {
    for (const mode of ENCRYPTION_MODES) {
      const header = rtpHeader(7, 960 * 7, 0xdeadbeef);
      const packet = encryptRtp(mode, key, header, opus, 7);
      const out = decryptRtp(mode, key, packet);
      expect(out, mode).not.toBeNull();
      expect(out!.payload.equals(opus), mode).toBe(true);
      expect(out!.header.readUInt32BE(8), mode).toBe(0xdeadbeef);
    }
  });

  it("rejects a packet under the wrong key or with a flipped byte", () => {
    const packet = encryptRtp("aead_aes256_gcm_rtpsize", key, rtpHeader(1, 960, 42), opus, 1);
    expect(decryptRtp("aead_aes256_gcm_rtpsize", newSecretKey(), packet)).toBeNull();
    const tampered = Buffer.from(packet);
    tampered[14] ^= 0x01;
    expect(decryptRtp("aead_aes256_gcm_rtpsize", key, tampered)).toBeNull();
  });

  // Libraries may send a one-byte header extension (Discord's audio-level extension); in the
  // rtpsize modes its 4-byte header is associated data and its words are the first encrypted
  // bytes. The forwarded packet must carry only the opus frame, with the X bit cleared.
  it("strips an RTP header extension in the rtpsize modes", () => {
    const fixed = rtpHeader(3, 2880, 99);
    fixed[0] |= 0x10;
    const extHeader = Buffer.from([0xbe, 0xde, 0x00, 0x01]);
    const extData = Buffer.from([0x10, 0x7f, 0x00, 0x00]);
    const clear = Buffer.concat([fixed, extHeader]);
    for (const mode of ["aead_aes256_gcm_rtpsize", "aead_xchacha20_poly1305_rtpsize"] as const) {
      // encrypt by hand the way a client would: AAD = fixed header + extension header
      const packet = encryptRtp(mode, key, clear, Buffer.concat([extData, opus]), 3);
      expect(rtpClearHeaderLength(packet)).toBe(16);
      const out = decryptRtp(mode, key, packet);
      expect(out, mode).not.toBeNull();
      expect(out!.payload.equals(opus), mode).toBe(true);
      expect(out!.header.length).toBe(12);
      expect(out!.header[0] & 0x10).toBe(0);
    }
  });
});

describe("ip discovery", () => {
  it("recognises a request and answers with the observed address", () => {
    const req = Buffer.alloc(74);
    req.writeUInt16BE(1, 0);
    req.writeUInt16BE(70, 2);
    req.writeUInt32BE(1234, 4);
    expect(parseIpDiscovery(req)).toEqual({ ssrc: 1234 });
    expect(parseIpDiscovery(Buffer.alloc(80))).toBeNull();
    const reply = ipDiscoveryReply(1234, "203.0.113.5", 51000);
    expect(reply.length).toBe(74);
    expect(reply.readUInt16BE(0)).toBe(2);
    expect(reply.readUInt32BE(4)).toBe(1234);
    expect(reply.subarray(8, 8 + 11).toString("ascii")).toBe("203.0.113.5");
    expect(reply[19]).toBe(0);
    expect(reply.readUInt16BE(72)).toBe(51000);
  });
});
