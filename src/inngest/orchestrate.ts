import type { CreatedData } from "./events";
import { WORKFLOW_TERMINAL } from "../core/workflow-events";
import type { WorkflowStore } from "../server/workflow-store";

export type DurableSteps = {
  run<T>(id: string, action: () => Promise<T>): Promise<T>;
  wait(id: string, until: string): Promise<void>;
  escalation(id: string, reason: string): Promise<void>;
  notifyWave?(requestId: string, index: number): Promise<void>;
};
/** The adapter supplies Inngest primitives; tests can inject a clock and replay journal. */
export async function orchestrate(data: CreatedData, runId: string, eventId: string, step: DurableSteps, store: () => Promise<WorkflowStore>) {
  await step.run("persist-request", async () => (await store()).initialize(data, runId, eventId));
  await step.run("stock-search", async () => (await store()).note(data.requestId, "STOCK_SEARCH"));
  const closure = () => step.run("closure", async () => (await store()).snapshot(data.requestId));
  // At most three steps per round, plus setup/closure: below Inngest's 1,000-step cap.
  for (let round = 0; round < 330; round++) {
    let state = await step.run(`reconcile-replies-readiness-${round}`, async () => {
      const current = await store();
      await current.reconcile(data.requestId);
      await current.maintain(data.requestId, round);
      return current.snapshot(data.requestId);
    });
    if (WORKFLOW_TERMINAL.includes(state.status)) return closure();
    if (state.due) {
      await step.run("close-deadline", async () => (await store()).close(data.requestId, "ESCALATED", state.issued ? "HANDOVER_OR_USE_TIMEOUT" : "DEADLINE_UNMET"));
      await step.escalation("publish-deadline-escalation", "DEADLINE_UNMET");
      return { status: "ESCALATED" };
    }
    if (state.allocated < state.quantity) {
      state = await step.run(`atomic-reservation-${round}`, async () => {
        const current = await store(); await current.reserve(data.requestId, round);
        return current.snapshot(data.requestId);
      });
      if (WORKFLOW_TERMINAL.includes(state.status)) return closure();
      if (state.allocated === state.quantity) continue; // Dispatch gets its own named step in the next round.
    }
    if (state.allocated === state.quantity) {
      state = await step.run(`dispatch-and-handover-readiness-${round}`, async () => {
        const current = await store();
        if (state.issued < state.quantity) await current.dispatch(data.requestId, round);
        await current.reconcile(data.requestId);
        const next = await current.snapshot(data.requestId);
        await current.note(data.requestId, next.issued === next.quantity ? next.handedOver === next.quantity ? "AWAITING_SYNTHETIC_USE" : "AWAITING_HANDOVER" : "AWAITING_BANK_APPROVAL");
        return next;
      });
    } else if (state.acceptedDonors < state.quantity - state.allocated && state.waveDue && state.waveCount < 3) {
      const waveIndex = state.waveCount;
      state = await step.run(`donor-wave-${waveIndex}`, async () => {
        const current = await store(); await current.wave(data.requestId, state.waveCount); await current.note(data.requestId, "AWAITING_DONORS");
        return current.snapshot(data.requestId);
      });
      await step.notifyWave?.(data.requestId, waveIndex);
    } else if (state.waveCount === 3 && state.waveDue && state.acceptedDonors === 0) {
      await step.run("close-exhausted-waves", async () => (await store()).close(data.requestId, "ESCALATED", "DONOR_WAVES_EXHAUSTED"));
      await step.escalation("publish-exhaustion-escalation", "DONOR_WAVES_EXHAUSTED");
      return { status: "ESCALATED" };
    }
    if (WORKFLOW_TERMINAL.includes(state.status)) return closure();
    await step.wait(`donor-or-readiness-or-handover-wait-${round}`, state.nextWakeAt);
  }
  await step.run("close-step-budget", async () => (await store()).close(data.requestId, "ESCALATED", "WORKFLOW_WAKE_BUDGET_REACHED"));
  await step.escalation("publish-budget-escalation", "WORKFLOW_WAKE_BUDGET_REACHED");
  return { status: "ESCALATED" };
}
