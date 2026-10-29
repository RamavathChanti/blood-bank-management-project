import { describe, expect, it } from "vitest";
import { GROUPS, type Group } from "../../src/core/domain";
import { compatibilityPreference, isCompatible, preferenceTier } from "../../src/core/compatibility";

// Independent literal recipient -> donors references, transcribed from Stage 0 sources.
// Do not derive expected values from antigen masks, preference functions, or fixtures.
const redCells: Record<Group, readonly Group[]> = {
  "O-": ["O-"], "O+": ["O-", "O+"], "A-": ["O-", "A-"], "A+": ["O-", "O+", "A-", "A+"],
  "B-": ["O-", "B-"], "B+": ["O-", "O+", "B-", "B+"], "AB-": ["O-", "A-", "B-", "AB-"], "AB+": ["O-", "O+", "A-", "A+", "B-", "B+", "AB-", "AB+"]
};
const plasma = { O: ["O", "A", "B", "AB"], A: ["A", "AB"], B: ["B", "AB"], AB: ["AB"] };
const plasmaExpanded: Record<Group, readonly Group[]> = {
  "O-": ["O-", "O+", "A-", "A+", "B-", "B+", "AB-", "AB+"], "O+": ["O-", "O+", "A-", "A+", "B-", "B+", "AB-", "AB+"],
  "A-": ["A-", "A+", "AB-", "AB+"], "A+": ["A-", "A+", "AB-", "AB+"],
  "B-": ["B-", "B+", "AB-", "AB+"], "B+": ["B-", "B+", "AB-", "AB+"], "AB-": ["AB-", "AB+"], "AB+": ["AB-", "AB+"]
};
const platelets = { "O-": ["O-"], "O+": ["O+"], "A-": ["A-"], "A+": ["A+"], "B-": ["B-"], "B+": ["B+"], "AB-": ["AB-"], "AB+": ["AB+"] };
const pairs = GROUPS.flatMap(donor => GROUPS.map(recipient => ({ donor, recipient })));
describe("independent 64-pair component truth tables", () => {
  it.each(pairs)("PRBC $donor -> $recipient", ({ donor, recipient }) => expect(isCompatible(donor, recipient, "PRBC")).toBe(redCells[recipient].includes(donor)));
  it.each(pairs)("FFP $donor -> $recipient", ({ donor, recipient }) => expect(isCompatible(donor, recipient, "FFP")).toBe(plasmaExpanded[recipient].includes(donor)));
  it.each(pairs)("platelets $donor -> $recipient", ({ donor, recipient }) => expect(isCompatible(donor, recipient, "PLATELETS")).toBe(platelets[recipient].includes(donor)));
  it.each([["PRBC", 27], ["FFP", 36], ["PLATELETS", 8]] as const)("%s accepted pair count is %i", (component, count) => expect(pairs.filter(({ donor, recipient }) => isCompatible(donor, recipient, component))).toHaveLength(count));
  it("checks the 16 plasma ABO combinations independently of Rh expansion", () => {
    for (const d of ["O", "A", "B", "AB"] as const) for (const r of ["O", "A", "B", "AB"] as const) expect(isCompatible(`${d}+`, `${r}-`, "FFP")).toBe(plasma[r].includes(d));
  });
  it("keeps preferences separate from biological compatibility", () => {
    expect(compatibilityPreference("A+", "PRBC")).toEqual(["A+", "O+", "A-", "O-"]);
    expect(compatibilityPreference("AB+", "PRBC")).toEqual(["AB+", "O+", "A-", "A+", "B-", "B+", "AB-", "O-"]);
    expect(compatibilityPreference("O-", "FFP")).toEqual(["O-", "O+", "A-", "A+", "B-", "B+", "AB-", "AB+"]);
    expect(preferenceTier("A-", "A+", "FFP")).toBe(preferenceTier("A+", "A+", "FFP"));
    expect(compatibilityPreference("A+", "PLATELETS")).toEqual(["A+"]);
  });
  it("rejects unsupported runtime groups and components", () => {
    expect(() => isCompatible("X" as Group, "O-", "PRBC")).toThrow();
    expect(() => isCompatible("O-", "A+", "WHOLE_BLOOD" as never)).toThrow();
  });
});
