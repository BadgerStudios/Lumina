import { describe, it, expect } from "vitest";
import { Permissions } from "@lumina/shared";
import { applyChannelOverwrites, type Overwrite, type OverwriteContext } from "./overwrites.js";

const EVERYONE = "role-everyone";
const MUTED = "role-muted";
const MOD = "role-mod";
const USER = "user-1";

const SEND = Permissions.SEND_MESSAGES;
const VIEW = Permissions.VIEW_CHANNELS;
const ATTACH = Permissions.ATTACH_FILES;

function ctx(over: Partial<OverwriteContext> = {}): OverwriteContext {
  return { base: VIEW | SEND, everyoneRoleId: EVERYONE, roleIds: [], userId: USER, ...over };
}

function role(targetId: string, allow: bigint, deny: bigint): Overwrite {
  return { targetType: "ROLE", targetId, allow, deny };
}
function member(targetId: string, allow: bigint, deny: bigint): Overwrite {
  return { targetType: "USER", targetId, allow, deny };
}

const has = (perms: bigint, bit: bigint) => (perms & bit) !== 0n;

describe("applyChannelOverwrites", () => {
  it("returns the base bitfield untouched when there are no overwrites", () => {
    expect(applyChannelOverwrites([], ctx())).toBe(VIEW | SEND);
  });

  it("ignores overwrites for roles the member does not hold", () => {
    const result = applyChannelOverwrites([role(MOD, 0n, SEND)], ctx());
    expect(has(result, SEND)).toBe(true);
  });

  it("applies a deny from a role the member does hold", () => {
    const result = applyChannelOverwrites([role(MOD, 0n, SEND)], ctx({ roleIds: [MOD] }));
    expect(has(result, SEND)).toBe(false);
  });

  it("grants a permission the member lacks server-wide", () => {
    // The point of an allow: the base bitfield does not include ATTACH_FILES at all.
    const result = applyChannelOverwrites([role(MOD, ATTACH, 0n)], ctx({ roleIds: [MOD] }));
    expect(has(result, ATTACH)).toBe(true);
  });

  describe("the @everyone / role ordering that a merged implementation gets wrong", () => {
    it("a role deny beats an @everyone allow (this is how muting works)", () => {
      // The case that motivates applying @everyone in its own step. Folding it into the role
      // accumulation re-grants SEND here and the muted member can post.
      const result = applyChannelOverwrites(
        [role(EVERYONE, SEND, 0n), role(MUTED, 0n, SEND)],
        ctx({ base: VIEW, roleIds: [MUTED] }),
      );
      expect(has(result, SEND)).toBe(false);
    });

    it("a role allow beats an @everyone deny (this is how private channels work)", () => {
      const result = applyChannelOverwrites(
        [role(EVERYONE, 0n, VIEW), role(MOD, VIEW, 0n)],
        ctx({ base: VIEW | SEND, roleIds: [MOD] }),
      );
      expect(has(result, VIEW)).toBe(true);
    });

    it("an @everyone deny hides the channel from a member with no other role", () => {
      const result = applyChannelOverwrites([role(EVERYONE, 0n, VIEW)], ctx());
      expect(has(result, VIEW)).toBe(false);
    });
  });

  describe("accumulation across multiple held roles", () => {
    it("allow wins over deny, and the result does not depend on listing order", () => {
      // Within the role step the allow is applied after the deny, so a grant from any held role
      // beats a denial from another. Matches Discord. The order-independence half of this matters
      // more than which side wins: a permission answer that changed with row order would be
      // unreproducible and impossible to reason about from the UI.
      const forwards = applyChannelOverwrites(
        [role(MOD, SEND, 0n), role(MUTED, 0n, SEND)],
        ctx({ roleIds: [MOD, MUTED] }),
      );
      const backwards = applyChannelOverwrites(
        [role(MUTED, 0n, SEND), role(MOD, SEND, 0n)],
        ctx({ roleIds: [MOD, MUTED] }),
      );
      expect(has(forwards, SEND)).toBe(true);
      expect(forwards).toBe(backwards);
    });
  });

  describe("member overwrites are last and beat everything", () => {
    it("a member allow overrides a role deny", () => {
      const result = applyChannelOverwrites(
        [role(MUTED, 0n, SEND), member(USER, SEND, 0n)],
        ctx({ roleIds: [MUTED] }),
      );
      expect(has(result, SEND)).toBe(true);
    });

    it("a member deny overrides a role allow", () => {
      const result = applyChannelOverwrites(
        [role(MOD, SEND, 0n), member(USER, 0n, SEND)],
        ctx({ base: VIEW, roleIds: [MOD] }),
      );
      expect(has(result, SEND)).toBe(false);
    });

    it("a member overwrite for someone else does not apply", () => {
      const result = applyChannelOverwrites([member("user-2", 0n, SEND)], ctx());
      expect(has(result, SEND)).toBe(true);
    });
  });

  it("leaves untouched bits alone", () => {
    // A deny of one bit must not disturb any other — the ~deny mask is easy to get wrong.
    const result = applyChannelOverwrites([role(MUTED, 0n, SEND)], ctx({ roleIds: [MUTED] }));
    expect(has(result, VIEW)).toBe(true);
  });

  it("a server with no default role does not crash", () => {
    // everyoneRoleId is "" when no isDefault role exists. The @everyone lookup must simply miss
    // rather than matching an overwrite whose targetId happens to be falsy.
    const result = applyChannelOverwrites([role(MOD, 0n, SEND)], ctx({ everyoneRoleId: "", roleIds: [MOD] }));
    expect(has(result, SEND)).toBe(false);
  });
});
