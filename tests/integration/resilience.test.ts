import { afterEach, expect, it, vi } from "vitest";
import { databaseFault, parseFlags, readDemoFlags, writeDemoFlags } from "../../src/server/demo-controls";
import { resilienceHandler } from "../../src/server/resilience-api";
import { traced, span, telemetrySnapshot } from "../../src/server/telemetry";
import { reconcileOutcome, reconciliation } from "../../src/core/resilience";
import type { Principal } from "../../src/server/identity";
import type { Db } from "mongodb";
import { Inngest } from "inngest";
import { createServer } from "node:http";
import { emergencyHandler } from "../../src/server/emergency-api";

const flags = () => ({ dbDown: true, dbSlowMs: 0, realtimeDown: true, expiresAt: new Date(Date.now() + 60_000).toISOString() });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function enabled() { vi.stubEnv("DEMO_CONTROLS_ENABLED", "1"); vi.stubEnv("EDGE_CONFIG", "https://edge-config.vercel.com/ecfg_test?token=private-read"); vi.stubEnv("GLOBAL_CONFIG", ""); }
it("bounds synthetic faults, expires them and fails closed when the control plane cannot be read", async () => {
  enabled();
  expect(() => parseFlags({ ...flags(), dbSlowMs: 3001 })).toThrow();
  expect(() => parseFlags({ ...flags(), extra: true })).toThrow();
  expect(() => parseFlags({ ...flags(), dbDown: "true" })).toThrow();
  expect(await readDemoFlags(vi.fn(async () => Response.json({ ...flags(), expiresAt: new Date(0).toISOString() })))).toMatchObject({ dbDown: false, realtimeDown: false });
  await expect(readDemoFlags(vi.fn(async () => { throw new Error("private token"); }))).rejects.toThrow("DEMO_CONFIG_UNAVAILABLE");
  await expect(databaseFault(async () => flags())).rejects.toThrow("DEMO_DATABASE_DOWN");
  const started = performance.now(); await databaseFault(async () => ({ ...flags(), dbDown: false, dbSlowMs: 50 }));
  expect(performance.now() - started).toBeGreaterThanOrEqual(40);
});
it("uses the current REST endpoint, never reports propagation as complete, and sanitizes transport errors", async () => {
  enabled(); vi.stubEnv("DEMO_CONFIG_WRITE_TOKEN", "private-write");
  const transport = vi.fn<typeof fetch>(async () => Response.json({}));
  expect(await writeDemoFlags(flags(), transport)).toEqual({ saved: true, propagationPending: true });
  expect(String(transport.mock.calls[0]?.[0])).toBe("https://api.vercel.com/v1/global-config/ecfg_test/items");
  await expect(writeDemoFlags(flags(), vi.fn(async () => new Response("private", { status: 401 })))).rejects.toThrow("DEMO_WRITE_UNCONFIRMED");
  await expect(writeDemoFlags({ ...flags(), expiresAt: new Date(Date.now() + 1_000_000).toISOString() })).rejects.toThrow("DEMO_EXPIRY_OUT_OF_RANGE");
});
it("rejects unexpected control hosts before sending credentials", async () => {
  enabled(); vi.stubEnv("EDGE_CONFIG", "https://attacker.example/ecfg_test?token=secret"); const transport = vi.fn();
  await expect(readDemoFlags(transport)).rejects.toThrow("DEMO_CONFIG_UNAVAILABLE"); expect(transport).not.toHaveBeenCalled();
});
it("requires admin identity and same-origin JSON before control writes; state reads survive Atlas failure", async () => {
  const write = vi.fn(async () => ({ saved: true, propagationPending: true }));
  const admin: Principal = { userId: "admin", role: "STATE_ADMIN", stateId: "maharashtra-pilot" };
  const deps = { identity: async () => admin, database: async (): Promise<Db> => { throw new Error("mongodb://private"); }, read: async () => flags(), write };
  const req = (origin: string) => new Request("https://app.test/api/resilience/flags", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(flags()) });
  expect((await resilienceHandler(deps)(req("https://evil.test"), ["flags"])).status).toBe(403); expect(write).not.toHaveBeenCalled();
  expect((await resilienceHandler({ ...deps, identity: async () => ({ ...admin, role: "HOSPITAL", hospitalId: "h", tenantId: "t" }) })(req("https://app.test"), ["flags"])).status).toBe(403);
  expect((await resilienceHandler(deps)(req("https://app.test"), ["flags"])).status).toBe(200); expect(write).toHaveBeenCalledOnce();
  const response = await resilienceHandler(deps)(new Request("https://app.test/api/resilience/status"), ["status"]);
  const body = await response.json(); expect(body.counts).toBeNull(); expect(body.alerts).toBeNull(); expect(body.services.atlas).toBe("unavailable"); expect(JSON.stringify(body)).not.toContain("mongodb://");
  expect(response.headers.get("cache-control")).toContain("no-store");
});
it("isolates concurrent trace contexts and emits sanitized timing headers", async () => {
  const handler = traced("test-api", async () => { await span("atlas", "synthetic-probe", async () => new Promise(r => setTimeout(r, 5))); return Response.json({ ok: true }); });
  const responses = await Promise.all([handler(new Request("https://a.test/?secret=x")), handler(new Request("https://a.test/?secret=y"))]);
  const ids = responses.map(r => r.headers.get("x-correlation-id")); expect(new Set(ids).size).toBe(2);
  expect(responses[0].headers.get("server-timing")).toMatch(/atlas\d;dur=/);
  const records = telemetrySnapshot().rows.filter(r => ids.includes(r.correlationId)); expect(records).toHaveLength(4); expect(JSON.stringify(records)).not.toMatch(/secret|a.test/);
});
it("accounts only the supplied acknowledged cohort and distinguishes terminal outcomes from fulfilment", () => {
  const rows = [undefined, "AWAITING_DONORS", "COMPLETED", "ESCALATED", "CANCELLED", "FAILED"].map((status, i) => reconcileOutcome(String(i), status ? { workflow: { status, acceptedAt: "2026-10-29T00:00:00Z", trace: [{ at: "2026-10-29T00:00:02Z" }] } } : undefined));
  expect(reconciliation(rows)).toMatchObject({ acknowledged: 6, pending: 1, accepted: 1, fulfilled: 1, escalated: 1, cancelled: 1, failed: 1, loss: null }); expect(rows[1].recoveryMs).toBe(2000);
});
it("real SDK retries an unavailable HTTP workflow ingress without issuing a false acknowledgement", async () => {
  let healthy = false, attempts = 0;
  const ingress = createServer((_request, response) => { attempts++; response.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" }); response.end(JSON.stringify(healthy ? { status: 200, ids: ["synthetic-provider-event"] } : { status: 503, error: "provider-private-message" })); });
  await new Promise<void>(resolve => ingress.listen(0, "127.0.0.1", resolve)); const address = ingress.address(); if (!address || typeof address === "string") throw new Error("port");
  const sender = new Inngest({ id: "isolated-ingress-rehearsal", isDev: false, eventKey: "synthetic-key", fetch: (_url, init) => fetch(`http://127.0.0.1:${address.port}/e/synthetic`, init) });
  const handler = emergencyHandler({ identity: async () => ({ userId: "synthetic-user", role: "HOSPITAL", hospitalId: "hospital", tenantId: "tenant", stateId: "maharashtra-pilot" }), database: async (): Promise<Db> => { throw new Error("must not need Atlas"); }, send: payload => sender.send(payload), secret: () => "synthetic-stable-secret-at-least-32-characters", configured: () => {}, now: () => new Date(), log: () => {} });
  const input = { key: "same-key", group: "O-", component: "PRBC", quantity: 1, urgency: "CRITICAL", expectedTransfusionAt: new Date(Date.now() + 3_600_000).toISOString() };
  const submit = () => handler(new Request("https://app.test/api/emergencies", { method: "POST", headers: { origin: "https://app.test", "Content-Type": "application/json" }, body: JSON.stringify(input) }));
  try {
    const response = await submit(), failed = await response.json();
    expect(response.status).toBe(503); expect(failed).toMatchObject({ accepted: false, status: "ACKNOWLEDGEMENT_UNKNOWN", retrySamePayload: true }); expect(failed.receipt).toBeUndefined(); expect(JSON.stringify(failed)).not.toContain("provider-private-message"); expect(attempts).toBeGreaterThan(1);
    healthy = true; const restored = await submit(), ack = await restored.json(); expect(restored.status).toBe(202); expect(ack.accepted).toBe(true); expect(ack.requestId).toBe(failed.requestId);
  } finally { ingress.closeAllConnections(); await new Promise<void>(resolve => ingress.close(() => resolve())); }
});
