import { describe, expect, it } from "vitest";
import type { PresenceStatus } from "@lumina/shared";
import { planPresenceReconciliation } from "./presence.js";

/**
 * The rule that decides who gets corrected. It is tested rather than trusted because both of its
 * failure modes are silent and bad in opposite directions: invert one condition and every connected
 * user is marked offline, drop the other and the drift this exists to stop comes straight back.
 *
 * The drift was real. `User.presence` was written on connect and on disconnect and nowhere else, so
 * a process that stopped — every deploy — left everyone who was connected reading ONLINE for good,
 * and the member list reads that column.
 */

const row = (id: string, presence: PresenceStatus) => ({ id, presence });
const connected = (...ids: string[]) => new Set(ids);

describe("planning a presence reconciliation", () => {
  it("marks someone offline when the column says online and no socket exists", () => {
    const plan = planPresenceReconciliation(connected(), [row("ghost", "ONLINE")]);
    expect(plan).toEqual({ toOffline: ["ghost"], toOnline: [] });
  });

  it("treats IDLE and DND as online states that still need correcting", () => {
    const plan = planPresenceReconciliation(connected(), [row("a", "IDLE"), row("b", "DND")]);
    expect(plan.toOffline).toEqual(["a", "b"]);
  });

  it("leaves a connected user alone", () => {
    const plan = planPresenceReconciliation(connected("here"), [row("here", "ONLINE")]);
    expect(plan).toEqual({ toOffline: [], toOnline: [] });
  });

  it("marks someone online when they hold a socket but the column says offline", () => {
    // The other half of the same fault: a connection counter stuck above zero means INCR never
    // returns 1 again, so this person is never marked ONLINE and looks offline while connected.
    const plan = planPresenceReconciliation(connected("stuck"), [row("stuck", "OFFLINE")]);
    expect(plan).toEqual({ toOffline: [], toOnline: ["stuck"] });
  });

  it("never touches INVISIBLE, connected or not", () => {
    // INVISIBLE is a choice, not an observation. It already displays as OFFLINE to everyone else,
    // and overwriting it would silently reveal someone who asked not to be seen.
    const plan = planPresenceReconciliation(connected("shown"), [
      row("shown", "INVISIBLE"),
      row("hidden", "INVISIBLE"),
    ]);
    expect(plan).toEqual({ toOffline: [], toOnline: [] });
  });

  it("leaves an offline, disconnected user alone rather than rewriting it", () => {
    expect(planPresenceReconciliation(connected(), [row("quiet", "OFFLINE")])).toEqual({
      toOffline: [],
      toOnline: [],
    });
  });

  it("sorts a mixed population into the right two buckets", () => {
    const plan = planPresenceReconciliation(connected("live", "stuck"), [
      row("live", "ONLINE"), // connected and correct
      row("ghost", "ONLINE"), // the drift
      row("stuck", "OFFLINE"), // connected but never marked
      row("hidden", "INVISIBLE"), // untouchable
      row("quiet", "OFFLINE"), // correct already
    ]);
    expect(plan).toEqual({ toOffline: ["ghost"], toOnline: ["stuck"] });
  });

  it("does nothing with nothing", () => {
    expect(planPresenceReconciliation(connected(), [])).toEqual({ toOffline: [], toOnline: [] });
  });
});
