import { expect, test } from "vitest";
const assert = { equal: (a: unknown, b: unknown) => expect(a).toBe(b), match: (a: string, r: RegExp) => expect(a).toMatch(r) };
import { describeUserAgent } from "./userAgent.js";

test("describeUserAgent: the common devices read plainly", () => {
  assert.equal(
    describeUserAgent("Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0 Mobile Safari/537.36", "mobile"),
    "Android 14 (SM-S918B) · Lumina app",
  );
  assert.equal(describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"), "Windows 10/11 · Chrome 128");
  assert.equal(describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"), "iPhone · Safari");
  assert.equal(describeUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Lumina/1.0.128 Chrome/138.0 Electron/37.0 Safari/537.36"), "Linux · Lumina desktop");
  assert.equal(describeUserAgent("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36"), "Android 10 · Chrome 128");
});

test("describeUserAgent: missing or odd input never throws", () => {
  expect(describeUserAgent(null)).toBe("Unknown device");
  expect(describeUserAgent(null, "mobile")).toBe("Lumina app");
  expect(describeUserAgent("curl/8.5.0")).toBe("Unknown OS · Browser");
});
