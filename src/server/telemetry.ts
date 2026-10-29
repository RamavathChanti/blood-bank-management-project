import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

type Service = "api" | "atlas" | "workflow" | "realtime" | "config";
export type Observation = { at: string; correlationId: string; requestId?: string; service: Service; operation: string; durationMs: number; ok: boolean; status?: number };
type Context = { id: string; requestId?: string; spans: Observation[] };
// Diagnostic samples only. Never use this ring as a durable acknowledgement ledger.
const global = globalThis as typeof globalThis & { pulsegridTelemetry?: { context: AsyncLocalStorage<Context>; rows: Observation[]; failures: Partial<Record<Service, number>>; recovery: Partial<Record<Service, number>> } };
const state = global.pulsegridTelemetry ??= { context: new AsyncLocalStorage<Context>(), rows: [], failures: {}, recovery: {} };
export function observation(service: Service, operation: string, durationMs: number, ok: boolean, status?: number) {
  const context = state.context.getStore();
  const row: Observation = { at: new Date().toISOString(), correlationId: context?.id ?? randomUUID(), ...(context?.requestId ? { requestId: context.requestId } : {}), service, operation, durationMs: Math.round(durationMs * 10) / 10, ok, ...(status ? { status } : {}) };
  state.rows.push(row); if (state.rows.length > 300) state.rows.shift();
  state.context.getStore()?.spans.push(row);
  if (!ok) state.failures[service] ??= Date.now();
  else if (state.failures[service] !== undefined) { state.recovery[service] = Date.now() - state.failures[service]!; delete state.failures[service]; }
  console.info(JSON.stringify({ event: "pulsegrid.observation", ...row }));
}
export async function span<T>(service: Service, operation: string, action: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { const result = await action(); observation(service, operation, performance.now() - started, true); return result; }
  catch (error) { observation(service, operation, performance.now() - started, false); throw error; }
}
export function telemetrySnapshot() {
  return { scope: "Last 300 observations in this warm process; not fleet metrics or a durable receipt ledger", rows: [...state.rows], recoveryMs: { ...state.recovery }, unavailableSince: { ...state.failures } };
}
export function traced<T extends unknown[]>(operation: string, handler: (request: Request, ...args: T) => Promise<Response>) {
  return (request: Request, ...args: T) => state.context.run({ id: randomUUID(), spans: [] }, async () => {
    const started = performance.now();
    const response = await handler(request, ...args);
    observation("api", operation, performance.now() - started, response.status < 500, response.status);
    const context = state.context.getStore()!;
    response.headers.set("X-Correlation-Id", context.id);
    response.headers.set("Server-Timing", context.spans.slice(0, 20).map((s, i) => `${s.service}${i};dur=${s.durationMs}`).join(", "));
    return response;
  });
}
export function workflowTrace<T>(requestId: string, action: () => Promise<T>, operation = "durable-step") {
  return state.context.run({ id: requestId, requestId, spans: [] }, () => span("workflow", operation, action));
}
export function correlateRequest(requestId: string) {
  if (/^emergency-[a-f0-9]{48}$/.test(requestId)) { const context = state.context.getStore(); if (context) context.requestId = requestId; }
}
