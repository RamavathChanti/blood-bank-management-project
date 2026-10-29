import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { MongoClient, type Db } from "mongodb";
import { resolve } from "node:path";
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
import { aggregatePublicBoard, publicBoardResponse } from "../../src/server/public-board";
import { SCREENS } from "../../src/core/domain";
import { STATE_ID } from "../../src/server/registry-constants";

let repl: MongoMemoryReplSet, client: MongoClient, db: Db;
const now = new Date("2026-10-29T12:00:00Z");
beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ binary: { version: "8.0.17", downloadDir: resolve(".tools/mongodb") }, replSet: { count: 1 } });
  client = await new MongoClient(repl.getUri()).connect(); db = client.db("pulsegrid_test_public");
  await db.collection("banks").insertMany([
    { _id: "bank-1", stateId: STATE_ID, tenantId: "tenant-1", district: "Pune", name: "PRIVATE BANK" },
    { _id: "bank-2", stateId: "other-state", tenantId: "tenant-2", district: "Pune" }
  ] as never[]);
  const unit = { stateId: STATE_ID, tenantId: "tenant-1", bankId: "bank-1", status: "AVAILABLE", storage: "VERIFIED", collectedAt: new Date(now.getTime() - 60_000), expiresAt: new Date(now.getTime() + 60_000), product: "PRBC_SAGM", group: "O-", component: "PRBC", screening: Object.fromEntries(SCREENS.map(screen => [screen, "NON_REACTIVE"])), donorId: "PRIVATE DONOR" };
  await db.collection("units").insertMany([
    unit, { ...unit }, { ...unit }, { ...unit }, // Four: LOW. Any invalid inclusion would cross the five-unit threshold.
    { ...unit, status: "RESERVED" }, { ...unit, storage: "UNKNOWN" }, { ...unit, expiresAt: now },
    { ...unit, screening: { ...unit.screening, HIV: "PENDING" } }, { ...unit, screening: {} },
    { ...unit, stateId: "other-state" }, { ...unit, tenantId: "other-tenant" },
    { ...unit, bankId: "bank-2", tenantId: "tenant-2" }, { ...unit, bankId: "missing" },
    { ...unit, reservation: { requestId: "private" } }, { ...unit, expiresAt: now.toISOString() },
    { ...unit, collectedAt: new Date(now.getTime() + 1000) }, { ...unit, product: "unknown" },
    { ...unit, component: "FFP" }, { ...unit, expiresAt: new Date(now.getTime() + 43 * 86_400_000) }
  ]);
});
afterAll(async () => { await client?.close(); await repl?.stop(); });
describe("public database and HTTP boundary", () => {
  it("counts only available, fully screened, verified, unexpired stock with valid state/tenant institution membership", async () => {
    const board = await aggregatePublicBoard(db, now);
    expect(board.cells.filter(cell => cell.band !== "NONE")).toEqual([{ district: "Pune", group: "O-", component: "PRBC", band: "LOW" }]);
    expect(JSON.stringify(board)).not.toMatch(/PRIVATE|donor|bank-1|tenant|request|screening|available|count/);
  });
  it("ignores stock counters and reflects authoritative inventory changes", async () => {
    await db.collection("stock").insertOne({ available: 99999 });
    await db.collection("units").updateOne({ status: "AVAILABLE", tenantId: "tenant-1", storage: "VERIFIED", expiresAt: { $gt: now } }, { $set: { status: "ISSUED" } });
    expect((await aggregatePublicBoard(db, now)).cells.find(cell => cell.district === "Pune" && cell.group === "O-" && cell.component === "PRBC")?.band).toBe("LOW");
  });
  it("returns a cacheable allowlisted aggregate independent of browser identity", async () => {
    const result = await publicBoardResponse(() => aggregatePublicBoard(db, now));
    expect(result.status).toBe(200); expect(result.headers.get("vercel-cdn-cache-control")).toContain("s-maxage=1");
    expect(result.headers.has("set-cookie")).toBe(false); expect(result.headers.has("vary")).toBe(false);
    expect(result.headers.has("x-vercel-cache")).toBe(false); // The application cannot invent a CDN observation.
    expect(Object.keys(await result.json())).toEqual(["schema", "generatedAt", "source", "cells"]);
  });
  it("cold failure returns uncached 503 without fabricated empty stock or provider details", async () => {
    const response = await publicBoardResponse(async () => { throw new Error("SECRET CONNECTION STRING"); });
    expect(response.status).toBe(503); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "PUBLIC_BOARD_UNAVAILABLE" });
  });
});
