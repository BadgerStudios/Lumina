import { describe, expect, it, vi } from "vitest";

vi.mock("../../config/env.js", () => ({ env: { UPLOADS_DIR: "/tmp" } }));

import { mergeDiscordFields } from "./multipart.js";

describe("multipart bodies from bots", () => {
  it("reads the JSON out of payload_json", () => {
    expect(mergeDiscordFields([{ name: "payload_json", value: JSON.stringify({ content: "hi", embeds: [] }) }])).toEqual({ content: "hi", embeds: [] });
  });
  it("lets plain fields stand in, with payload_json taking precedence", () => {
    expect(mergeDiscordFields([{ name: "content", value: "loose" }, { name: "payload_json", value: "{\"content\":\"json\"}" }])).toEqual({ content: "json" });
    expect(mergeDiscordFields([{ name: "content", value: "loose" }])).toEqual({ content: "loose" });
  });
  it("refuses a payload_json that is not JSON", () => {
    expect(() => mergeDiscordFields([{ name: "payload_json", value: "{nope" }])).toThrow(/not valid JSON/);
  });
});
