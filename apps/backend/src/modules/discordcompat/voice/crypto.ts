import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import sodium from "libsodium-wrappers";

/**
 * Discord voice transport encryption, both directions.
 *
 * A voice packet is an RTP packet whose payload is encrypted under the session key the server
 * handed out in SESSION_DESCRIPTION. Five modes exist in the wild; the two "_rtpsize" AEAD modes
 * are what current libraries pick, the three xsalsa20 modes are what older ones still send.
 *
 *   rtpsize modes: the RTP header — 12 bytes, plus 4 per CSRC, plus the 4-byte extension header
 *   when the X bit is set — stays in the clear and is the AEAD's associated data. Everything
 *   after it (the extension words, then the opus frame) is encrypted; the 16-byte tag follows;
 *   then a 4-byte incrementing counter which is the nonce, zero-padded to the cipher's nonce
 *   length (12 for AES-GCM, 24 for XChaCha20).
 *
 *   xsalsa20_poly1305:        nonce = the 12-byte RTP header padded to 24, nothing appended.
 *   xsalsa20_poly1305_suffix: 24 random bytes appended, used as the nonce.
 *   xsalsa20_poly1305_lite:   4-byte counter appended, padded to 24.
 *   (secretbox has no associated data; the header is simply left in front.)
 */

export const ENCRYPTION_MODES = [
  "aead_aes256_gcm_rtpsize",
  "aead_xchacha20_poly1305_rtpsize",
  "xsalsa20_poly1305_lite",
  "xsalsa20_poly1305_suffix",
  "xsalsa20_poly1305",
] as const;
export type EncryptionMode = (typeof ENCRYPTION_MODES)[number];

export function isEncryptionMode(v: unknown): v is EncryptionMode {
  return typeof v === "string" && (ENCRYPTION_MODES as readonly string[]).includes(v);
}

let ready: Promise<void> | null = null;
export function cryptoReady(): Promise<void> {
  ready ??= sodium.ready;
  return ready;
}

export function newSecretKey(): Buffer {
  return randomBytes(32);
}

/** Bytes of RTP header that stay in the clear in the rtpsize modes: fixed header + CSRCs + extension header. */
export function rtpClearHeaderLength(packet: Buffer): number {
  if (packet.length < 12) return 0;
  const csrcCount = packet[0] & 0x0f;
  const hasExtension = (packet[0] & 0x10) !== 0;
  const len = 12 + csrcCount * 4 + (hasExtension ? 4 : 0);
  return len <= packet.length ? len : 0;
}

/** How many bytes of extension data sit at the start of the decrypted plaintext (rtpsize modes). */
function extensionDataLength(packet: Buffer, clearLen: number): number {
  const hasExtension = (packet[0] & 0x10) !== 0;
  if (!hasExtension) return 0;
  const words = packet.readUInt16BE(clearLen - 2);
  return words * 4;
}

export interface DecryptedRtp {
  /** The clear RTP header bytes (12 + CSRCs; the extension header is dropped along with its data). */
  header: Buffer;
  /** The opus frame. */
  payload: Buffer;
}

/** Decrypts a packet the bot sent. Null when it does not verify (a stray packet, a wrong key). */
export function decryptRtp(mode: EncryptionMode, key: Buffer, packet: Buffer): DecryptedRtp | null {
  try {
    if (mode === "aead_aes256_gcm_rtpsize" || mode === "aead_xchacha20_poly1305_rtpsize") {
      const clearLen = rtpClearHeaderLength(packet);
      if (!clearLen || packet.length < clearLen + 16 + 4) return null;
      const aad = packet.subarray(0, clearLen);
      const nonceSuffix = packet.subarray(packet.length - 4);
      const body = packet.subarray(clearLen, packet.length - 4); // ciphertext + tag
      let plain: Buffer;
      if (mode === "aead_aes256_gcm_rtpsize") {
        const nonce = Buffer.alloc(12);
        nonceSuffix.copy(nonce, 0);
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(body.subarray(body.length - 16));
        plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
      } else {
        const nonce = Buffer.alloc(24);
        nonceSuffix.copy(nonce, 0);
        plain = Buffer.from(sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, body, aad, nonce, key));
      }
      const extLen = extensionDataLength(packet, clearLen);
      const fixedLen = 12 + (packet[0] & 0x0f) * 4;
      const header = Buffer.from(packet.subarray(0, fixedLen));
      header[0] &= ~0x10; // the extension is gone from what we forward
      return { header, payload: extLen ? plain.subarray(extLen) : plain };
    }
    // legacy secretbox modes: the 12-byte header is in the clear, the rest is one secretbox
    if (packet.length < 12 + 16) return null;
    const header = Buffer.from(packet.subarray(0, 12));
    let nonce: Buffer;
    let cipher: Buffer;
    if (mode === "xsalsa20_poly1305") {
      nonce = Buffer.alloc(24);
      header.copy(nonce, 0);
      cipher = packet.subarray(12);
    } else if (mode === "xsalsa20_poly1305_suffix") {
      if (packet.length < 12 + 16 + 24) return null;
      nonce = Buffer.from(packet.subarray(packet.length - 24));
      cipher = packet.subarray(12, packet.length - 24);
    } else {
      if (packet.length < 12 + 16 + 4) return null;
      nonce = Buffer.alloc(24);
      packet.subarray(packet.length - 4).copy(nonce, 0);
      cipher = packet.subarray(12, packet.length - 4);
    }
    const plain = Buffer.from(sodium.crypto_secretbox_open_easy(cipher, nonce, key));
    return { header, payload: plain };
  } catch {
    return null;
  }
}

/**
 * Encrypts an opus frame for the bot. `header` is a plain 12-byte RTP header (no CSRCs, no
 * extension) carrying the SSRC we assigned to this person; `counter` is this session's outgoing
 * nonce counter, which the caller increments per packet.
 */
export function encryptRtp(mode: EncryptionMode, key: Buffer, header: Buffer, payload: Buffer, counter: number): Buffer {
  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE(counter >>> 0, 0);
  if (mode === "aead_aes256_gcm_rtpsize") {
    const nonce = Buffer.alloc(12);
    suffix.copy(nonce, 0);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(header);
    const body = Buffer.concat([cipher.update(payload), cipher.final()]);
    return Buffer.concat([header, body, cipher.getAuthTag(), suffix]);
  }
  if (mode === "aead_xchacha20_poly1305_rtpsize") {
    const nonce = Buffer.alloc(24);
    suffix.copy(nonce, 0);
    const body = Buffer.from(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(payload, header, null, nonce, key));
    return Buffer.concat([header, body, suffix]);
  }
  if (mode === "xsalsa20_poly1305") {
    const nonce = Buffer.alloc(24);
    header.copy(nonce, 0);
    return Buffer.concat([header, Buffer.from(sodium.crypto_secretbox_easy(payload, nonce, key))]);
  }
  if (mode === "xsalsa20_poly1305_suffix") {
    const nonce = randomBytes(24);
    return Buffer.concat([header, Buffer.from(sodium.crypto_secretbox_easy(payload, nonce, key)), nonce]);
  }
  const nonce = Buffer.alloc(24);
  suffix.copy(nonce, 0);
  return Buffer.concat([header, Buffer.from(sodium.crypto_secretbox_easy(payload, nonce, key)), suffix]);
}

/** A plain 12-byte RTP header for opus (Discord's payload type 120). */
export function rtpHeader(sequence: number, timestamp: number, ssrc: number, marker = false): Buffer {
  const h = Buffer.alloc(12);
  h[0] = 0x80;
  h[1] = (marker ? 0x80 : 0) | 120;
  h.writeUInt16BE(sequence & 0xffff, 2);
  h.writeUInt32BE(timestamp >>> 0, 4);
  h.writeUInt32BE(ssrc >>> 0, 8);
  return h;
}

/**
 * IP discovery: 74-byte request (type 1, length 70, ssrc, 64-byte address, 2-byte port) answered
 * with the same layout, type 2, carrying the address and port the packet arrived on as seen by
 * this server. Returns null for anything that is not a discovery request.
 */
export function parseIpDiscovery(packet: Buffer): { ssrc: number } | null {
  if (packet.length !== 74) return null;
  if (packet.readUInt16BE(0) !== 1 || packet.readUInt16BE(2) !== 70) return null;
  return { ssrc: packet.readUInt32BE(4) };
}

export function ipDiscoveryReply(ssrc: number, address: string, port: number): Buffer {
  const reply = Buffer.alloc(74);
  reply.writeUInt16BE(2, 0);
  reply.writeUInt16BE(70, 2);
  reply.writeUInt32BE(ssrc >>> 0, 4);
  reply.write(address, 8, 64, "ascii");
  reply.writeUInt16BE(port & 0xffff, 72);
  return reply;
}
