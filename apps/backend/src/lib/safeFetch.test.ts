import { describe, expect, it } from "vitest";
import { isBlockedAddress } from "./safeFetch.js";

/**
 * The address predicate behind link unfurling.
 *
 * Worth real tests rather than a smoke check, because every one of these cases is a way an SSRF
 * gets through a "we check for private IPs" implementation that was written from memory. The
 * IPv4-mapped IPv6 forms in particular are the classic bypass: `::ffff:127.0.0.1` reaches exactly
 * the same host as `127.0.0.1`, and a blocklist that only knows about dotted quads waves it past.
 */
describe("isBlockedAddress", () => {
  it("blocks loopback", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("127.255.255.254")).toBe(true);
    expect(isBlockedAddress("::1")).toBe(true);
  });

  it("blocks RFC1918 private space", () => {
    expect(isBlockedAddress("10.0.0.1")).toBe(true);
    expect(isBlockedAddress("172.16.0.1")).toBe(true);
    expect(isBlockedAddress("172.31.255.255")).toBe(true);
    expect(isBlockedAddress("192.168.1.1")).toBe(true);
  });

  it("allows the addresses either side of the 172.16/12 range", () => {
    // 172.15 and 172.32 are public. A blocklist written as "starts with 172." would wrongly
    // refuse both, which is a correctness bug rather than a security one — but it is the sort
    // that gets fixed by widening the check until something real gets through.
    expect(isBlockedAddress("172.15.255.255")).toBe(false);
    expect(isBlockedAddress("172.32.0.0")).toBe(false);
  });

  it("blocks cloud instance metadata", () => {
    // The single most valuable SSRF target on any cloud host: credentials, in plaintext, over HTTP,
    // with no authentication.
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
  });

  it("blocks carrier-grade NAT and benchmarking space", () => {
    expect(isBlockedAddress("100.64.0.1")).toBe(true);
    expect(isBlockedAddress("198.18.0.1")).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 forms of private addresses", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::FFFF:192.168.0.1")).toBe(true);
  });

  it("blocks unique-local, link-local and multicast IPv6", () => {
    expect(isBlockedAddress("fc00::1")).toBe(true);
    expect(isBlockedAddress("fd12:3456::1")).toBe(true);
    expect(isBlockedAddress("fe80::1")).toBe(true);
    expect(isBlockedAddress("ff02::1")).toBe(true);
  });

  it("blocks NAT64 and 6to4, which translate straight back into v4 space", () => {
    expect(isBlockedAddress("64:ff9b::7f00:1")).toBe(true);
    expect(isBlockedAddress("2002:7f00:0001::")).toBe(true);
  });

  it("blocks anything that is not an IP address at all", () => {
    // The lookup gate hands this whatever DNS returned. A non-address reaching it means something
    // is wrong, and the safe reading of "I do not recognise this" is "do not dial it".
    expect(isBlockedAddress("")).toBe(true);
    expect(isBlockedAddress("localhost")).toBe(true);
    expect(isBlockedAddress("not-an-ip")).toBe(true);
  });

  it("allows ordinary public addresses", () => {
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
    expect(isBlockedAddress("1.1.1.1")).toBe(false);
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });
});
