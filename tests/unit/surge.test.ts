import { describe, expect, it } from "vitest";
import { surgeScenario, surgeTick, surgeMetrics, percentile95, type SurgeState } from "../../src/core/surge";
import { COST_LIMITS, costProjection } from "../../src/core/cost-limits";
function finish(state: SurgeState) { for (let i = 0; i < 200 && surgeMetrics(state).completed < state.jobs.length; i++) state = surgeTick(state); return state; }
describe("bounded synthetic surge", () => {
  it("rejects oversized, fractional and invalid scenarios/ticks", () => {
    for (const n of [0, 3, 21, 1000, 4.5, NaN]) expect(() => surgeScenario(n)).toThrow();
    for (const n of [0, 3, NaN]) expect(() => surgeScenario(12, n)).toThrow();
    for (const n of [0, -100, 50, NaN, 1100]) expect(() => surgeTick(surgeScenario(), n)).toThrow();
  });
  it("respects the executing cap, preserves IDs and drains every admitted job", () => {
    for (const slots of [1, 2]) { const s = finish(surgeScenario(20, slots)); expect(s.peakActive).toBe(slots); expect(s.peakQueued).toBeGreaterThan(0); expect(surgeMetrics(s)).toMatchObject({ acknowledged: 20, completed: 20, queued: 0, active: 0 }); expect(new Set(s.jobs.map(j => j.id)).size).toBe(20); }
  });
  it("later critical jobs overtake queued urgent jobs without preempting executing jobs", () => {
    const s = finish(surgeScenario(12, 2, true));
    expect(s.jobs[0].startedMs).toBe(100); expect(s.jobs[1].startedMs).toBe(100);
    expect(s.jobs[10].startedMs).toBe(900); expect(s.jobs[11].startedMs).toBe(900); expect(s.jobs[2].startedMs).toBeGreaterThan(900);
    const fifo = finish(surgeScenario(12, 2, false)); expect(fifo.jobs[2].startedMs).toBe(900); expect(fifo.jobs[10].startedMs).toBeGreaterThan(fifo.jobs[2].startedMs!);
  });
  it("stop retains incomplete jobs and repeated replay is deterministic without mutating input", () => {
    const initial = surgeScenario(), snapshot = JSON.stringify(initial), next = surgeTick(initial, 1000);
    expect(JSON.stringify(initial)).toBe(snapshot);
    const stopped = { ...next, stopped: true }; expect(surgeTick(stopped)).toBe(stopped);
    expect(finish(surgeScenario())).toEqual(finish(surgeScenario()));
    let chunks = initial; for (let i = 0; i < 10; i++) chunks = surgeTick(chunks); expect(next).toEqual(chunks);
  });
  it("uses nearest-rank p95 and reports no latency before completions", () => { expect(percentile95([])).toBeNull(); expect(percentile95([100, 1, 2, 3])).toBe(100); expect(surgeMetrics(surgeScenario()).p95Ms).toBeNull(); });
});
describe("dated cost assumptions", () => {
  it("accounts for 300 bank polling screens as well as workflow traffic", () => {
    expect(costProjection()).toMatchObject({ requests: 30000, executions: 900000, polling: 8640000, invocations: 9690000, estimatedDbCommands: 14640000, paidBaseFloorUSD: 175.94, optionalAblyBaseUSD: 29 });
    expect(costProjection().freeExecutionDays).toBeCloseTo(1.6667, 3);
    expect(costProjection({ ...COST_LIMITS.assumptions, bankPollSeconds: 60 }).polling).toBe(4320000);
  });
  it("allows a zero-request estimate and rejects invalid time, NaN or negative assumptions", () => {
    expect(costProjection({ ...COST_LIMITS.assumptions, requestsPerDay: 0, banks: 0 })).toMatchObject({ invocations: 0, executions: 0, freeExecutionDays: null });
    for (const change of [{ bankPollSeconds: 0 }, { days: -1 }, { executionsPerRequest: NaN }, { memoryGB: -1 }, { wallMsPerInvocation: 1 }]) expect(() => costProjection({ ...COST_LIMITS.assumptions, ...change })).toThrow();
  });
});
