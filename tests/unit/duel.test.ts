import { describe, expect, it } from "vitest";
import { runDuel } from "../../src/core/duel";

describe("isolated Duel teaching fixture", () => {
  it("replays the stale-read race with two claims for one unit", () => {
    expect(runDuel("NAIVE")).toMatchObject({ owners: ["Hospital A", "Hospital B"], doubleAllocations: 1 });
  });
  it("conditional claim admits one owner and resets independently on each run", () => {
    expect(runDuel("ATOMIC")).toMatchObject({ owners: ["Hospital A"], doubleAllocations: 0 });
    runDuel("NAIVE"); expect(runDuel("ATOMIC")).toEqual(runDuel("ATOMIC"));
  });
});
