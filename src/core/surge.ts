/** Shared queue policy. Priority adjusts queue age in seconds; it never preempts. */
export const ATLAS_WORKFLOW_SLOTS = 2;
export const ATLAS_WORKFLOW_CONCURRENCY = { limit: ATLAS_WORKFLOW_SLOTS, key: '"pulsegrid-atlas"', scope: "env" as const };
export const CRITICAL_PRIORITY = "event.data.input.urgency == 'CRITICAL' ? 120 : 0";
export const SURGE_LIMITS = { maxRequests: 20, defaultRequests: 12, maxSlots: 2, serviceMs: 800, criticalPrioritySeconds: 120 } as const;
export type SurgeJob = { id: string; urgency: "URGENT" | "CRITICAL"; enqueuedMs: number; startedMs: number | null; finishedMs: number | null };
export type SurgeState = { jobs: SurgeJob[]; nowMs: number; slots: number; priority: boolean; stopped: boolean; peakActive: number; peakQueued: number };
export function surgeScenario(count: number = SURGE_LIMITS.defaultRequests, slots = 2, priority = true): SurgeState {
  if (!Number.isInteger(count) || count < 4 || count > SURGE_LIMITS.maxRequests || !Number.isInteger(slots) || slots < 1 || slots > SURGE_LIMITS.maxSlots) throw new Error("Use 4–20 requests and 1–2 slots.");
  return { nowMs: 0, slots, priority, stopped: false, peakActive: 0, peakQueued: 0, jobs: Array.from({ length: count }, (_, i) => ({ id: `synthetic-${i + 1}`, urgency: i >= count - 2 ? "CRITICAL" : "URGENT", enqueuedMs: i < slots ? 0 : i >= count - 2 ? 200 : 100, startedMs: null, finishedMs: null })) };
}
export function surgeTick(previous: SurgeState, deltaMs = 100): SurgeState {
  if (!Number.isInteger(deltaMs) || deltaMs < 100 || deltaMs > 1000 || deltaMs % 100) throw new Error("Use a 100 ms tick multiple, at most 1000 ms");
  if (previous.stopped) return previous;
  const state = { ...previous, jobs: previous.jobs.map(j => ({ ...j })) };
  const until = state.nowMs + deltaMs;
  while (state.nowMs < until) {
    state.nowMs += 100;
    for (const j of state.jobs) if (j.startedMs !== null && j.finishedMs === null && j.startedMs + SURGE_LIMITS.serviceMs <= state.nowMs) j.finishedMs = state.nowMs;
    const active = state.jobs.filter(j => j.startedMs !== null && j.finishedMs === null).length;
    const queue = state.jobs.filter(j => j.startedMs === null && j.enqueuedMs <= state.nowMs).sort((a, b) => (a.enqueuedMs - (state.priority && a.urgency === "CRITICAL" ? 120000 : 0)) - (b.enqueuedMs - (state.priority && b.urgency === "CRITICAL" ? 120000 : 0)) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    state.peakQueued = Math.max(state.peakQueued, queue.length);
    for (const j of queue.slice(0, state.slots - active)) j.startedMs = state.nowMs;
    state.peakActive = Math.max(state.peakActive, state.jobs.filter(j => j.startedMs !== null && j.finishedMs === null).length);
  }
  return state;
}
export function percentile95(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * .95) - 1];
}
export function surgeMetrics(state: SurgeState) {
  const done = state.jobs.filter(j => j.finishedMs !== null);
  return { acknowledged: state.jobs.length, completed: done.length, active: state.jobs.filter(j => j.startedMs !== null && j.finishedMs === null).length, queued: state.jobs.filter(j => j.startedMs === null && j.enqueuedMs <= state.nowMs).length, p95Ms: percentile95(done.map(j => j.finishedMs! - j.enqueuedMs)), throughput: state.nowMs ? done.length / (state.nowMs / 1000) : 0 };
}
