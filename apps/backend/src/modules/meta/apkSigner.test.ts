import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readApkSignerSha256 } from "./apkSigner.js";

/**
 * The parser walks bytes out of the artifact we hand to a client's package installer, and every
 * length it follows comes from that same file. So the cases that matter are as much "refuses to
 * believe a malformed file" as "reads a real one" — a wrong answer here tells someone their update
 * cannot install when it can, or the reverse.
 *
 * The fixture is assembled rather than checked in: an 8MB APK in the repo to exercise 80 lines of
 * length-walking would be a poor trade, and building the structure by hand documents it.
 */

/** A length-prefixed field, the way every sequence inside the signing block is framed. */
function lp(payload: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(payload.length, 0);
  return Buffer.concat([length, payload]);
}

function u64(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value), 0);
  return buf;
}

/**
 * The smallest file shaped like a signed APK: some entry bytes, a signing block holding one
 * id-to-value pair, then an EOCD pointing at where the central directory would start.
 */
function buildApk(options: { cert: Buffer; blockId?: number; magic?: string; declaredSize?: number }): Buffer {
  const { cert, blockId = 0x7109871a, magic = "APK Sig Block 42" } = options;

  // signer = [ signedData = [ digests ][ certificates ] ][ signatures ][ publicKey ]
  const digests = lp(Buffer.from("digest-placeholder"));
  const certificates = lp(lp(cert));
  const signedData = lp(Buffer.concat([digests, certificates]));
  const signer = lp(Buffer.concat([signedData, lp(Buffer.alloc(0)), lp(Buffer.alloc(0))]));
  const signers = lp(signer);

  const idValue = Buffer.concat([Buffer.alloc(4), signers]);
  idValue.writeUInt32LE(blockId, 0);
  const pair = Buffer.concat([u64(idValue.length), idValue]);

  // block = [ uint64 size ][ pairs ][ uint64 size ][ 16-byte magic ]; size excludes the first field.
  const blockSize = options.declaredSize ?? pair.length + 8 + 16;
  const block = Buffer.concat([u64(blockSize), pair, u64(blockSize), Buffer.from(magic, "latin1")]);

  const entries = Buffer.from("fake local file header bytes");
  const centralDirOffset = entries.length + block.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt32LE(centralDirOffset, 16);

  return Buffer.concat([entries, block, eocd]);
}

let dir: string;
const at = (name: string) => path.join(dir, name);
const write = async (name: string, bytes: Buffer) => {
  await writeFile(at(name), bytes);
  return at(name);
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "apksigner-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("reading an APK's signer certificate", () => {
  const cert = Buffer.from("a pretend DER-encoded X.509 certificate");
  const expected = createHash("sha256").update(cert).digest("hex");

  it("reads the signer out of a v2 signing block", async () => {
    expect(await readApkSignerSha256(await write("v2.apk", buildApk({ cert })))).toBe(expected);
  });

  it("falls back to the v3 block when there is no v2 one", async () => {
    expect(await readApkSignerSha256(await write("v3.apk", buildApk({ cert, blockId: 0xf05368c0 })))).toBe(expected);
  });

  it("returns null for a block id it does not understand rather than guessing", async () => {
    expect(await readApkSignerSha256(await write("other.apk", buildApk({ cert, blockId: 0x1234abcd })))).toBeNull();
  });

  it("returns null when the signing-block magic is absent, as on a v1-only or unsigned APK", async () => {
    expect(await readApkSignerSha256(await write("v1.apk", buildApk({ cert, magic: "NOT A SIG BLOCK!" })))).toBeNull();
  });

  it("refuses a size field that does not agree with itself", async () => {
    // The leading and trailing sizes bracket the block; a file claiming one length at the front and
    // another at the back is not one we should be reading lengths out of at all.
    expect(await readApkSignerSha256(await write("skew.apk", buildApk({ cert, declaredSize: 9_999 })))).toBeNull();
  });

  it("refuses an absurd declared size instead of allocating it", async () => {
    expect(await readApkSignerSha256(await write("huge.apk", buildApk({ cert, declaredSize: 2 ** 40 })))).toBeNull();
  });

  it("returns null for a file with no EOCD at all", async () => {
    expect(await readApkSignerSha256(await write("plain.bin", Buffer.alloc(4096, 7)))).toBeNull();
  });

  it("returns null for a truncated file", async () => {
    expect(await readApkSignerSha256(await write("tiny.apk", Buffer.from("PK")))).toBeNull();
  });

  it("returns null for a file that is not there", async () => {
    expect(await readApkSignerSha256(at("absent.apk"))).toBeNull();
  });
});
