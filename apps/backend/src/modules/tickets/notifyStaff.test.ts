import { describe, expect, it } from "vitest";
import { STAFF_ROLES, queueBody, type QueueKind } from "./notifyStaff.js";
import { ROLE_LADDER, isStaff } from "../../lib/platformRole.js";

const KINDS: QueueKind[] = ["report", "support", "system", "video"];

describe("who hears about the queue", () => {
  it("is every rank from MODERATOR up, and no ordinary user", () => {
    expect(STAFF_ROLES).not.toContain("USER");
    expect(STAFF_ROLES).toEqual(["MODERATOR", "ADMIN", "EXECUTIVE", "OWNER", "MASTER"]);
  });

  // The failure this guards is silent: add a rank above MODERATOR to the ladder, and a hand-written
  // list would leave those people responsible for a queue they are never told about.
  it("stays in step with the ladder itself", () => {
    expect(STAFF_ROLES).toEqual(ROLE_LADDER.filter(isStaff));
  });
});

describe("what a lock screen shows", () => {
  it("names the kind and the backlog", () => {
    expect(queueBody("report", 3)).toBe("A user or message was reported. 3 items are waiting.");
    expect(queueBody("support", 12)).toBe("Someone opened a support ticket. 12 items are waiting.");
  });

  // "1 items are waiting" reads as broken, and a count of one adds nothing over the headline.
  it("drops the count when this is the only thing waiting", () => {
    expect(queueBody("video", 1)).toBe("A video was reported.");
  });

  // A count can legitimately be 0: the item may have been resolved between the insert and the read.
  it("survives a count of zero rather than claiming nothing happened", () => {
    expect(queueBody("system", 0)).toBe("The platform flagged something itself.");
  });

  /**
   * The property that matters. These land on lock screens, are read in public, and are about people
   * who did not consent to being the subject of them — so the body must be a function of the kind
   * and a number, and of nothing a reporter typed.
   */
  it("is built only from the kind and a count", () => {
    for (const kind of KINDS) {
      for (const waiting of [0, 1, 2, 99]) {
        const body = queueBody(kind, waiting);
        const withoutCount = body.replace(String(waiting), "");
        // Every character that is not the count must come from the fixed headline for that kind.
        expect(withoutCount).toMatch(/^[A-Za-z .]*$/);
        expect(body.startsWith(queueBody(kind, 1).replace(/\.$/, ""))).toBe(true);
      }
    }
  });
});
