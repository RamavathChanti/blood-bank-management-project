import { afterAll, beforeAll, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { MongoClient, type Db, type Document } from "mongodb";
import { resolve } from "node:path";
import { BSON } from "mongodb";
import { runForecastJob, forecastDay, FORECAST_JOB_LIMITS } from "../../src/server/forecast-jobs";
import { seedRegistry } from "../../src/server/seed";
import { Registry } from "../../src/server/registry";
import { STATE_ID } from "../../src/server/registry-constants";
import { DAY_MS } from "../../src/core/shelf-life";

type Row = Document & { _id: string };
const at = "2026-10-29T20:30:00.000Z", now = new Date(at), from = new Date(now.getTime() - 70 * DAY_MS).toISOString();
let repl: MongoMemoryReplSet, client: MongoClient, db: Db;
beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ binary: { version: "8.0.17", downloadDir: resolve(".tools/mongodb") }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  client = await new MongoClient(repl.getUri()).connect(); db = client.db("pulsegrid_test_forecast");
  await seedRegistry(client, db, { confirm: db.databaseName, at: from });
  const template = (await db.collection<Row>("units").findOne({}))!;
  for (let i = 0; i < 70; i++) {
    const id = `historical-issue-${i}`, time = new Date(Date.parse(from) + i * DAY_MS + 1000);
    await db.collection<Row>("units").insertOne({ ...template, _id: id, id, group: "A+", component: "PRBC", product: "PRBC_SAGM", bankId: "demo-bank-2", tenantId: "tenant-demo-bank-2", status: "ISSUED", collectedAt: new Date(time.getTime() - DAY_MS), expiresAt: new Date(time.getTime() + 10 * DAY_MS), reservation: { requestId: `synthetic-${i}`, allocationId: `allocation-${i}`, recipientGroup: "A+", reservedAt: time.toISOString(), leaseExpiresAt: new Date(time.getTime() + 600000).toISOString(), expectedTransfusionAt: new Date(time.getTime() + 3600000).toISOString() } });
    await db.collection<Row>("unitEvents").insertOne({ _id: id, id, stateId: STATE_ID, tenantId: "tenant-demo-bank-2", bankId: "demo-bank-2", unitId: id, at: time, actorId: "synthetic-fixture", action: "ISSUE" });
  }
  await db.collection("units").updateOne({ id: template.id }, { $set: { group: "A+", component: "PRBC", product: "PRBC_SAGM", bankId: "demo-bank-1", tenantId: "tenant-demo-bank-1", collectedAt: new Date(now.getTime() - 40 * DAY_MS), expiresAt: new Date(now.getTime() + 2 * DAY_MS) } });
});
afterAll(async () => { await client?.close(); await repl?.stop(); });
it("keys the daily receipt by IST rather than host date", () => {
  expect(forecastDay(at)).toEqual({ day: "2026-10-30", cutoff: "2026-10-29T18:30:00.000Z" });
});
it("concurrent/retried schedules commit one result without changing stock or lifecycle history", async () => {
  const before = JSON.stringify(await db.collection("units").find({}).sort({ _id: 1 }).toArray()), eventCount = await db.collection("unitEvents").countDocuments();
  const results = await Promise.all([runForecastJob(db, at), runForecastJob(db, at), runForecastJob(db, at)]);
  expect(results[1]).toEqual(results[0]); expect(results[2]).toEqual(results[0]); expect(await db.collection("operations").countDocuments({ tenantId: "state-forecast-scheduler" })).toBe(1);
  expect(results[0].measured.resultBytes).toBe(BSON.calculateObjectSize(results[0])); expect(results[0].measured.resultBytes).toBeLessThan(FORECAST_JOB_LIMITS.resultBytes);
  expect(results[0].weather.some(r => r.rate.state === "OBSERVED")).toBe(true); expect(results[0].plannedTransfers.length).toBeGreaterThan(0);
  expect(JSON.stringify(await db.collection("units").find({}).sort({ _id: 1 }).toArray())).toBe(before); expect(await db.collection("unitEvents").countDocuments()).toBe(eventCount);
  // A retry after stock changes returns the committed receipt, not a second plan.
  await db.collection("units").updateOne({ id: "seed-unit-2" }, { $set: { status: "DISCARDED" } });
  expect(await runForecastJob(db, at)).toEqual(results[0]);
});
it("only a state admin can inspect the retained private proposal", async () => {
  const admin = new Registry(db, { userId: "admin", role: "STATE_ADMIN", stateId: STATE_ID }, now);
  const response = await admin.read(["state", "forecast"]); expect(response).toHaveProperty("forecast.kind", "REGISTRY_FORECAST_PROPOSAL");
  const bank = new Registry(db, { userId: "bank", role: "BANK", bankId: "demo-bank-1", tenantId: "tenant-demo-bank-1", stateId: STATE_ID }, now);
  await expect(bank.read(["state", "forecast"])).rejects.toMatchObject({ status: 403 });
});
it("has no imported synthetic history when coverage is absent and respects logical receipt TTL", async () => {
  await db.collection<Row>("_registryMeta").deleteOne({ _id: "seed" });
  const later = new Date(now.getTime() + DAY_MS).toISOString(), result = await runForecastJob(db, later);
  expect(result.weather.every(r => r.rate.state === "MISSING_HISTORY")).toBe(true); expect(result.plannedTransfers).toEqual([]);
  const expired = new Registry(db, { userId: "admin", role: "STATE_ADMIN", stateId: STATE_ID }, new Date(now.getTime() + 40 * DAY_MS));
  expect(await expired.read(["state", "forecast"])).toEqual({ forecast: null });
});
it("rejects oversized input instead of silently planning on a truncated subset", async () => {
  const rows = Array.from({ length: 37 }, (_, i) => ({ _id: `extra-${i}`, id: `extra-${i}`, stateId: STATE_ID, tenantId: `extra-${i}`, name: "Synthetic extra", district: "Thane", location: { type: "Point", coordinates: [73, 19] } }));
  await db.collection<Row>("banks").insertMany(rows);
  await expect(runForecastJob(db, new Date(now.getTime() + 2 * DAY_MS).toISOString())).rejects.toMatchObject({ code: "FORECAST_INPUT_BUDGET_EXCEEDED" });
  expect(await db.collection("operations").countDocuments({ tenantId: "state-forecast-scheduler" })).toBe(2);
});
