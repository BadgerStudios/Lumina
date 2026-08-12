import { describe, expect, it } from "vitest";
import { matchContent, type CompiledRule } from "./service.js";

const rule = (over: Partial<CompiledRule> = {}): CompiledRule => ({
  id: "r1",
  name: "No advertising",
  terms: ["buy now"],
  wholeWord: false,
  exemptRoleIds: [],
  ...over,
});

/**
 * The matcher is pure and its failure modes are combinatorial, which is exactly what belongs in a
 * unit test rather than a live script. Both directions matter: a filter that misses is useless, and
 * a filter that over-matches blocks innocent messages with no explanation, which is worse — the
 * sender did nothing wrong and has no way to work out what happened.
 */
describe("AutoMod matching", () => {
  it("matches a plain substring", () => {
    expect(matchContent("hey, buy now while stocks last", [rule()])?.term).toBe("buy now");
  });

  it("is case-insensitive", () => {
    expect(matchContent("BUY NOW", [rule()])).not.toBeNull();
  });

  it("sees through separator padding", () => {
    // The obvious evasion, and the reason substring matching alone is not enough.
    for (const attempt of ["b u y n o w", "b.u.y.n.o.w", "b-u-y-n-o-w", "b*u*y*n*o*w"]) {
      expect(matchContent(attempt, [rule({ terms: ["buynow"] })]), attempt).not.toBeNull();
    }
  });

  it("does not match when the term is absent", () => {
    expect(matchContent("just saying hello", [rule()])).toBeNull();
  });

  it("wholeWord mode avoids the Scunthorpe problem", () => {
    // The failure this mode exists for: a term inside an ordinary word blocking innocent messages.
    const substring = rule({ terms: ["ass"], wholeWord: false });
    const whole = rule({ terms: ["ass"], wholeWord: true });
    expect(matchContent("I need to pass this class", [substring])).not.toBeNull();
    expect(matchContent("I need to pass this class", [whole])).toBeNull();
    // …while still catching the standalone word.
    expect(matchContent("don't be an ass", [whole])).not.toBeNull();
  });

  it("treats a term with regex metacharacters literally", () => {
    // A rule for "a.b" must not match "axb" — an operator typing a dot means a dot.
    const dotted = rule({ terms: ["a.b"], wholeWord: true });
    expect(matchContent("axb", [dotted])).toBeNull();
    expect(matchContent("a.b", [dotted])).not.toBeNull();
  });

  it("skips a rule the member is exempt from, but not the others", () => {
    const rules = [
      rule({ id: "r1", name: "Slurs", terms: ["badword"], exemptRoleIds: ["mod"] }),
      rule({ id: "r2", name: "Spam", terms: ["buy now"] }),
    ];
    // Exempt from the first, so it passes…
    expect(matchContent("badword", rules, ["mod"])).toBeNull();
    // …but the exemption is per rule, not a blanket bypass.
    expect(matchContent("buy now", rules, ["mod"])?.ruleId).toBe("r2");
  });

  it("returns the rule name so the sender learns what they broke", () => {
    // The name is disclosed and the term is not — a name is written for humans, while echoing the
    // matched term back turns the error into an oracle for probing the blocklist word by word.
    const match = matchContent("buy now", [rule({ name: "No advertising" })]);
    expect(match?.ruleName).toBe("No advertising");
  });

  it("handles empty content and empty rule sets without throwing", () => {
    expect(matchContent("", [rule()])).toBeNull();
    expect(matchContent("anything", [])).toBeNull();
    expect(matchContent("anything", [rule({ terms: [] })])).toBeNull();
  });
});
