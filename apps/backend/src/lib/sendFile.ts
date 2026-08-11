import { createReadStream } from "node:fs";
import type { FastifyReply } from "fastify";

/**
 * Streams a file with real HTTP Range support (RFC 7233).
 *
 * This exists because the original attachment route replied with a whole-file stream and a bare
 * Content-Length — fine for images, broken for media. Without `Accept-Ranges`/206 a browser cannot
 * seek: scrubbing a video restarts it or hangs, and Safari/iOS refuses to play a media source that
 * can't serve ranges at all (it issues a probing `Range: bytes=0-1` request before anything else
 * and gives up on a 200). So this isn't only new-feature scaffolding for the video feed — routing
 * the existing attachment route through here fixes seeking for video/audio already posted in chat.
 *
 * Single-range only. A multi-range request would require a multipart/byteranges body; no browser
 * media element asks for one, so those fall back to a normal 200 full-body response rather than
 * carrying an encoder that would never run.
 */
export function sendFileWithRange(
  reply: FastifyReply,
  filePath: string,
  opts: { mimeType: string; sizeBytes: number; rangeHeader?: string; fileName?: string; inline?: boolean },
): FastifyReply {
  const { mimeType, sizeBytes, rangeHeader, fileName } = opts;

  reply.header("Content-Type", mimeType);
  // Advertised unconditionally, including on the full-body 200 path: clients look for this on the
  // FIRST response to decide whether seeking is possible at all, before ever sending a Range.
  reply.header("Accept-Ranges", "bytes");
  if (fileName) {
    const disposition = opts.inline === false ? "attachment" : "inline";
    reply.header("Content-Disposition", `${disposition}; filename="${encodeURIComponent(fileName)}"`);
  }

  const range = rangeHeader ? parseRange(rangeHeader, sizeBytes) : undefined;

  if (range === "unsatisfiable") {
    // 416 must carry the real size so the client can correct itself and retry.
    reply.header("Content-Range", `bytes */${sizeBytes}`);
    return reply.code(416).send();
  }

  if (!range) {
    reply.header("Content-Length", sizeBytes.toString());
    return reply.send(createReadStream(filePath));
  }

  const { start, end } = range;
  reply.header("Content-Range", `bytes ${start}-${end}/${sizeBytes}`);
  reply.header("Content-Length", (end - start + 1).toString());
  reply.code(206);
  // createReadStream's `end` is inclusive, matching Content-Range's inclusive semantics — no
  // off-by-one adjustment needed here, which is the usual bug in hand-rolled range handlers.
  return reply.send(createReadStream(filePath, { start, end }));
}

/**
 * Returns the resolved byte window, `undefined` to mean "serve the whole file normally", or
 * "unsatisfiable" for a syntactically valid range that falls outside the file (→ 416).
 *
 * Anything malformed resolves to `undefined` rather than an error: RFC 7233 says an unparseable
 * Range header must be ignored, not rejected.
 */
function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return undefined;

  let start: number;
  let end: number;

  if (rawStart === "") {
    // Suffix form (`bytes=-500`): the LAST n bytes, not a range starting at 0. Clamped so a
    // suffix longer than the file yields the whole file rather than a negative start offset.
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
    // A start at or past EOF is unsatisfiable; an end past EOF is merely clamped (clients
    // routinely send an optimistic large end, and 416-ing those would break playback).
    if (start >= size) return "unsatisfiable";
    end = Math.min(end, size - 1);
    if (end < start) return "unsatisfiable";
  }

  // A zero-byte file has no satisfiable range at all.
  if (size === 0) return "unsatisfiable";

  return { start, end };
}
