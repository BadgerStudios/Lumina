import { open } from "node:fs/promises";
import { createHash } from "node:crypto";

/**
 * Reads the certificate an APK is signed with, straight out of the file being served.
 *
 * Why this exists: Android refuses to update an installed app with a package signed by a different
 * certificate, and there is no way for the client to find that out except by downloading the whole
 * APK and watching the system installer reject it. Publishing the signer digest next to the file
 * digest lets the client compare before it downloads, and say something useful instead of leaving
 * the user with the installer's "App not installed".
 *
 * It is read from the APK rather than configured, for the same reason the content digest is
 * computed rather than recorded: a value someone has to remember to update is a value that will
 * eventually describe a different file than the one being served.
 *
 * The layout (APK Signature Scheme v2, Android 7+):
 *
 *   …zip entries… | APK Signing Block | Central Directory | EOCD
 *
 * The signing block is a length-prefixed bag of id→value pairs bracketed by its own size and the
 * magic "APK Sig Block 42", sitting immediately before the central directory. Inside the v2 (or
 * v3) pair, the first signer's signed data begins with two length-prefixed sequences: the content
 * digests, then the certificate chain. The first certificate of that chain is the signer, as DER,
 * and its SHA-256 is what `apksigner verify --print-certs` prints and what Android compares.
 */

const EOCD_SIGNATURE = 0x06054b50;
/** EOCD is 22 bytes plus a comment of up to 64KB, so that is how far back it can start. */
const EOCD_SEARCH_BYTES = 22 + 0xffff;
const APK_SIG_BLOCK_MAGIC = "APK Sig Block 42";
const V2_BLOCK_ID = 0x7109871a;
const V3_BLOCK_ID = 0xf05368c0;
/** A signing block this large means the file is not what we think it is; refuse rather than
 * allocate it. Real ones are a few KB. */
const MAX_SIGNING_BLOCK_BYTES = 32 * 1024 * 1024;

/**
 * The SHA-256 of the signer certificate, lowercase hex — the same digest `apksigner
 * verify --print-certs` reports. Null for anything this cannot read with certainty: a v1-only
 * (JAR-signed) APK, an unsigned one, or a file that is not an APK at all. Null is a normal answer
 * and means "do not claim to know", never "mismatch".
 */
export async function readApkSignerSha256(filePath: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    if (size < 64) return null;

    // ── 1. the end of central directory, and through it the start of the central directory
    const tailLength = Math.min(size, EOCD_SEARCH_BYTES);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) return null;
    const centralDirOffset = tail.readUInt32LE(eocd + 16);
    if (centralDirOffset <= 0 || centralDirOffset >= size) return null;

    // ── 2. the signing block, which ends where the central directory begins
    //    …| uint64 size | pairs | uint64 size | 16-byte magic |…
    if (centralDirOffset < 24) return null;
    const footer = Buffer.alloc(24);
    await handle.read(footer, 0, 24, centralDirOffset - 24);
    if (footer.subarray(8, 24).toString("latin1") !== APK_SIG_BLOCK_MAGIC) return null;

    const blockSize = asLength(footer.readBigUInt64LE(0));
    if (blockSize === null || blockSize > MAX_SIGNING_BLOCK_BYTES) return null;
    // The trailing size counts everything after the leading size field, so the block starts
    // `blockSize + 8` before the central directory.
    const blockStart = centralDirOffset - blockSize - 8;
    if (blockStart < 0) return null;

    const block = Buffer.alloc(blockSize + 8);
    await handle.read(block, 0, block.length, blockStart);
    if (asLength(block.readBigUInt64LE(0)) !== blockSize) return null;

    // ── 3. the v2 (or v3) pair within it
    const pairs = block.subarray(8, 8 + blockSize - 24);
    const signerBlock = findSignerBlock(pairs);
    if (!signerBlock) return null;

    // ── 4. first signer → signed data → certificates → first certificate
    const signers = lengthPrefixed(signerBlock);
    const firstSigner = signers ? first(signers) : null;
    if (!firstSigner) return null;
    const signedData = first(firstSigner);
    if (!signedData) return null;
    // signed data = [ digests ][ certificates ][ … ]; skip the digests to reach the chain.
    const digests = first(signedData);
    if (!digests) return null;
    const certificates = first(signedData.subarray(4 + digests.length));
    if (!certificates) return null;
    const signerCert = first(certificates);
    if (!signerCert || signerCert.length === 0) return null;

    return createHash("sha256").update(signerCert).digest("hex");
  } catch {
    // A malformed or truncated file is not an error worth propagating — the caller treats a null
    // as "unknown" and the update flow carries on without the extra check.
    return null;
  } finally {
    await handle.close();
  }
}

/** The v2 pair if present, else v3. Both wrap their signers identically for our purposes. */
function findSignerBlock(pairs: Buffer): Buffer | null {
  let v3: Buffer | null = null;
  let offset = 0;
  while (offset + 12 <= pairs.length) {
    const pairLength = asLength(pairs.readBigUInt64LE(offset));
    if (pairLength === null || pairLength < 4 || offset + 8 + pairLength > pairs.length) return v3;
    const id = pairs.readUInt32LE(offset + 8);
    const value = pairs.subarray(offset + 12, offset + 8 + pairLength);
    if (id === V2_BLOCK_ID) return value;
    if (id === V3_BLOCK_ID && !v3) v3 = value;
    offset += 8 + pairLength;
  }
  return v3;
}

/** The contents of a uint32-length-prefixed sequence, or null if the prefix does not fit. */
function lengthPrefixed(buf: Buffer): Buffer | null {
  if (buf.length < 4) return null;
  const length = buf.readUInt32LE(0);
  if (length > buf.length - 4) return null;
  return buf.subarray(4, 4 + length);
}

/** The first uint32-length-prefixed element of a sequence. */
function first(seq: Buffer): Buffer | null {
  return lengthPrefixed(seq);
}

/** A uint64 field narrowed to a usable length, or null when it could not be one. */
function asLength(value: bigint): number | null {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}
