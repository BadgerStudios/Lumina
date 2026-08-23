import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

/**
 * An outbound HTTP client for URLs that a *user* chose.
 *
 * Every other outbound request this backend makes goes to a host the operator configured — Stripe,
 * the SMTP relay, R2. Link unfurling is different in kind: the destination is typed into a chat
 * message by anyone with an account, and the request leaves from inside the Docker network, where
 * `postgres`, `redis` and `backend` all resolve by name and none of them are exposed publicly.
 * A naive `fetch(url)` in that position is a server-side request forgery primitive that reaches
 * every internal service, plus (on a cloud host) the instance metadata endpoint at 169.254.169.254.
 *
 * So this module is written around one rule: **no socket is ever opened to an address that has not
 * been checked, and the check happens at connect time, not before it.**
 *
 * ## Why the check lives in a `lookup` callback
 *
 * The obvious implementation — resolve the hostname, verify the IP, then call fetch — has a hole
 * you can drive a truck through. Between the check and the request, the attacker's DNS server
 * answers again, this time with 127.0.0.1. That is DNS rebinding, and it defeats every
 * check-then-fetch design no matter how good the IP predicate is.
 *
 * Node's `http.request` accepts a custom `lookup`, which is called by the agent at the moment it is
 * about to connect, and whose result is the address actually dialled. Validating there means the
 * address we approved and the address we connect to are the same value — there is no window.
 *
 * ## What else is enforced
 *
 * - http/https only. `file:`, `gopher:`, `ftp:` and friends are rejected at parse.
 * - Every redirect hop is re-validated. Answering the first request with a 302 to an internal
 *   address is the classic bypass, and it costs nothing to defend against.
 * - Response body capped and the socket destroyed the moment the cap is passed, so a remote host
 *   cannot stream gigabytes into a preview fetch.
 * - Hard total timeout, separate from the socket-level one.
 * - No credentials, no cookies, and userinfo in the URL is stripped.
 */

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

/** Total wall-clock budget for one URL including all redirects. */
const TOTAL_TIMEOUT_MS = 5_000;
const SOCKET_TIMEOUT_MS = 3_000;
const MAX_REDIRECTS = 3;
/** 256KB is far more `<head>` than any real page has, and small enough to be uninteresting. */
const MAX_BYTES = 256 * 1024;

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inV4Cidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number.parseInt(bitsRaw, 10);
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

/**
 * Everything that is not a public unicast address.
 *
 * Deliberately a denylist of ranges rather than "is it in a known-good list", because the set of
 * routable public addresses is not enumerable. Each entry is here for a reason:
 * 169.254.0.0/16 covers cloud instance metadata; 100.64.0.0/10 is carrier-grade NAT, which on some
 * hosts is where the LAN actually lives; 198.18.0.0/15 is benchmarking space that some networks
 * use internally.
 */
const BLOCKED_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

export function isBlockedAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) return BLOCKED_V4.some((cidr) => inV4Cidr(address, cidr));
  if (version !== 6) return true; // not an IP at all — never dial it

  const ip = address.toLowerCase();

  // An IPv4-mapped v6 address (::ffff:127.0.0.1) reaches exactly the same host as the v4 form, so
  // it has to go through the same predicate. Missing this is a very common way for an otherwise
  // careful blocklist to be bypassed.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return isBlockedAddress(mapped[1]);

  if (ip === "::" || ip === "::1") return true;
  if (ip.startsWith("fe80:") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) return true; // link-local fe80::/10
  if (/^f[cd]/.test(ip)) return true; // unique-local fc00::/7
  if (ip.startsWith("ff")) return true; // multicast
  if (ip.startsWith("64:ff9b:")) return true; // NAT64, which translates straight back into v4 space
  if (ip.startsWith("2002:")) return true; // 6to4, same reasoning as NAT64

  // Only global unicast (2000::/3) survives.
  return !/^[23]/.test(ip);
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;

/**
 * The gate. Called by the HTTP agent immediately before it connects, with the result of this
 * function being the address it dials.
 */
function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback | ((err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void),
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      (callback as LookupCallback)(err, "", 0);
      return;
    }
    const list = (Array.isArray(addresses) ? addresses : [addresses]) as dns.LookupAddress[];
    // ALL answers must be acceptable, not merely the first. A record set of
    // [93.184.216.34, 127.0.0.1] would otherwise pass while leaving the agent free to fall back to
    // the second address on a connection error.
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad || list.length === 0) {
      const reason = bad
        ? `${hostname} resolves to a non-public address (${bad.address})`
        : `${hostname} does not resolve`;
      (callback as LookupCallback)(Object.assign(new Error(reason), { code: "EBLOCKED" }), "", 0);
      return;
    }
    if (options.all) {
      (callback as (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void)(null, list);
    } else {
      (callback as LookupCallback)(null, list[0].address, list[0].family);
    }
  });
}

export interface SafeResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** The URL the body actually came from, after any redirects. */
  finalUrl: string;
  truncated: boolean;
}

function parseTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError("Not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`Unsupported scheme ${url.protocol}`);
  }
  // `http://user:pass@internal-host/` — the credentials would be sent to whatever the redirect
  // chain ends at, and some proxies parse the userinfo section as the host.
  url.username = "";
  url.password = "";
  // A literal IP still has to pass the predicate; the lookup gate below would catch it too, but
  // failing here gives an accurate reason instead of a DNS-shaped one.
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(literal) && isBlockedAddress(literal)) {
    throw new BlockedUrlError(`${literal} is not a public address`);
  }
  return url;
}

/**
 * What a caller will accept back. The defaults are the link-preview behaviour this module was
 * written for — HTML only, anything else dropped unread — because that is what makes a preview
 * fetch safe against a 4GB ISO behind a link.
 *
 * A JSON caller (the bot onboarding worker reading npm/GitHub metadata) needs the same SSRF
 * hardening — pinned DNS, rebinding checks, redirect re-validation, byte cap — against a
 * different content type, so it passes its own instead of getting an empty body and a 200.
 */
export interface SafeFetchOptions {
  /** Sent as the Accept header. */
  accept?: string;
  /** Response content-types that may be read. A response outside it is dropped unread. */
  contentTypePattern?: RegExp;
}

const HTML_CONTENT_TYPES = /^\s*(text\/html|application\/xhtml\+xml)/i;
export const JSON_FETCH: SafeFetchOptions = {
  accept: "application/json,text/plain;q=0.9",
  contentTypePattern: /^\s*(application\/json|application\/vnd\.github|text\/plain)/i,
};

function requestOnce(url: URL, deadline: number, userAgent: string, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new BlockedUrlError("Timed out"));
      return;
    }

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        lookup: guardedLookup as never,
        timeout: Math.min(SOCKET_TIMEOUT_MS, remaining),
        headers: {
          // Honest about what this is. A site that would rather not be unfurled can refuse it.
          "user-agent": userAgent,
          accept: options.accept ?? "text/html,application/xhtml+xml",
          // Compression is declined on purpose: a decompressor turns the byte cap into a cap on
          // *compressed* bytes, and a zip bomb expands well past it.
          "accept-encoding": "identity",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let truncated = false;

        // A preview only ever needs HTML. Anything else (a 4GB ISO, a video) is dropped without
        // reading a byte of the body.
        const contentType = String(res.headers["content-type"] ?? "");
        const isRedirect = res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400;
        if (!isRedirect && contentType && !(options.contentTypePattern ?? HTML_CONTENT_TYPES).test(contentType)) {
          res.destroy();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.alloc(0), finalUrl: url.toString(), truncated: false });
          return;
        }
        const declared = Number.parseInt(String(res.headers["content-length"] ?? ""), 10);
        if (Number.isFinite(declared) && declared > MAX_BYTES) {
          res.destroy();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.alloc(0), finalUrl: url.toString(), truncated: true });
          return;
        }

        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_BYTES) {
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (received - MAX_BYTES))));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("close", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            finalUrl: url.toString(),
            truncated,
          });
        });
        res.on("error", () => {
          // A destroy() we caused ourselves lands here; whatever was read is still usable.
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            finalUrl: url.toString(),
            truncated,
          });
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new BlockedUrlError("Timed out"));
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      reject(err.code === "EBLOCKED" ? new BlockedUrlError(err.message) : err);
    });
    req.end();
  });
}

/**
 * Fetches a user-supplied URL, following redirects with the address check reapplied at every hop.
 *
 * Throws BlockedUrlError when the target is not a legitimate public destination — callers should
 * treat that as a cached negative rather than a retryable failure, because it will not become true
 * later.
 */
export async function safeFetch(
  rawUrl: string,
  userAgent = "LuminaBot/1.0 (+link preview)",
  options: SafeFetchOptions = {},
): Promise<SafeResponse> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let url = parseTarget(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await requestOnce(url, deadline, userAgent, options);
    const location = res.headers.location;
    const isRedirect = res.status >= 300 && res.status < 400 && typeof location === "string" && location.length > 0;
    if (!isRedirect) return res;

    if (hop === MAX_REDIRECTS) throw new BlockedUrlError("Too many redirects");
    // Resolved against the current URL so a relative Location works, then put through the exact
    // same parse/validate as the original. This is the hop that a check-once implementation misses.
    url = parseTarget(new URL(location, url).toString());
  }

  throw new BlockedUrlError("Too many redirects");
}
