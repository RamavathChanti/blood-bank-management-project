import { describe, expect, it } from "vitest";
import { createSimulationConfig } from "../../src/core/simulation-config";

describe("explicit simulation configuration", () => {
  it("normalizes timezone equivalents without using the wall clock", () => {
    const utc = createSimulationConfig("monsoon", "2026-10-28T03:30:00Z");
    const ist = createSimulationConfig(" monsoon ", "2026-10-28T09:00:00+05:30");
    expect(ist).toEqual(utc);
    expect(utc).toEqual({ seed: "monsoon", startedAt: "2026-10-28T03:30:00.000Z" });
    expect(Object.isFrozen(utc)).toBe(true);
  });

  it.each(["", "  "])("rejects an empty seed %j", seed => {
    expect(() => createSimulationConfig(seed, "2026-10-28T03:30:00Z")).toThrow("seed");
  });

  it.each(["2026-10-28", "2026-10-28T09:00:00", "not-a-date", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z"])("rejects ambiguous or invalid clocks %j", clock => {
    expect(() => createSimulationConfig("monsoon", clock)).toThrow();
  });
});
