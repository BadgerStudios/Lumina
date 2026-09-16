import { describe, expect, it, vi } from "vitest";

// The poster itself touches the database and the socket server; only the wording is tested here.
vi.mock("../../db/prisma.js", () => ({ prisma: {} }));
vi.mock("../../realtime/io.js", () => ({ getIO: () => ({ to: () => ({ emit: () => undefined }) }) }));
vi.mock("./service.js", () => ({ messageInclude: {} }));

import { DEFAULT_JOIN_TEMPLATE, DEFAULT_LEAVE_TEMPLATE, TEMPLATE_MAX_LENGTH, pickTemplate, renderSystemTemplate } from "./systemMessages.js";

const ctx = { username: "lucid", displayName: "Lucid", space: "Lumina Official", count: 42 };

describe("announcement wording", () => {
  it("fills every placeholder, mentioning the member by username", () => {
    expect(renderSystemTemplate("{user} ({name}) joined {space} — now {count} of us", ctx)).toBe(
      "@lucid (Lucid) joined Lumina Official — now 42 of us",
    );
  });
  it("falls back to the username when there is no display name", () => {
    expect(renderSystemTemplate("Welcome {name}", { ...ctx, displayName: null })).toBe("Welcome lucid");
  });
  it("leaves unknown braces visible instead of swallowing them", () => {
    expect(renderSystemTemplate("{user} {rank}", ctx)).toBe("@lucid {rank}");
  });
  it("has sensible built-in lines", () => {
    expect(renderSystemTemplate(DEFAULT_JOIN_TEMPLATE, ctx)).toBe("@lucid just joined Lumina Official. Say hi!");
    expect(renderSystemTemplate(DEFAULT_LEAVE_TEMPLATE, ctx)).toBe("@lucid left Lumina Official.");
  });
});

describe("which template applies", () => {
  it("uses the space's own words when it has any", () => {
    expect(pickTemplate("join", "  Welcome aboard, {user}!  ")).toBe("Welcome aboard, {user}!");
  });
  it("uses the built-in line for empty or missing custom text", () => {
    expect(pickTemplate("join", null)).toBe(DEFAULT_JOIN_TEMPLATE);
    expect(pickTemplate("leave", "   ")).toBe(DEFAULT_LEAVE_TEMPLATE);
  });
  it("caps runaway templates", () => {
    expect(pickTemplate("join", "x".repeat(TEMPLATE_MAX_LENGTH + 50)).length).toBe(TEMPLATE_MAX_LENGTH);
  });
});
