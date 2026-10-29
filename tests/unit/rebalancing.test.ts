import { expect, it } from "vitest";
import { bloodWeather, DEFAULT_FORECAST, readyUnit } from "../../src/core/forecast";
import { fixtureBanks, FIXTURE_NOW, inventoryFixtures } from "../../src/core/fixtures";
import { DEFAULT_REBALANCE, dispatchTransfer, minCostFlow, planRebalancing, receiveTransfers, transitIds } from "../../src/core/rebalancing";
import { DAY_MS } from "../../src/core/shelf-life";
import type { HistoricalIssue } from "../../src/core/state-generator";
import { distanceKm, travelMinutes } from "../../src/core/emergency-matching";

it("uses reverse residual edges to beat greedy assignment under shared capacity", () => {
  // Greedy A→X (1) forces B→Y (100); optimal A→Y (2), B→X (2) costs 4.
  const result = minCostFlow(6, [{ from: 0, to: 1, capacity: 1, cost: 0 }, { from: 0, to: 2, capacity: 1, cost: 0 }, { from: 1, to: 3, capacity: 1, cost: 1 }, { from: 1, to: 4, capacity: 1, cost: 2 }, { from: 2, to: 3, capacity: 1, cost: 2 }, { from: 2, to: 4, capacity: 1, cost: 100 }, { from: 3, to: 5, capacity: 1, cost: 0 }, { from: 4, to: 5, capacity: 1, cost: 0 }], 0, 5);
  expect(result.flow).toBe(2); expect(result.cost).toBe(4); expect(result.edgeFlows.slice(2, 6)).toEqual([0, 1, 1, 0]);
});
const now = FIXTURE_NOW, from = new Date(Date.parse(now) - 56 * DAY_MS).toISOString();
const units = () => inventoryFixtures().filter(u => ["DEMO-001", "DEMO-002"].includes(u.id)).map(u => ({ ...u }));
const history: HistoricalIssue[] = Array.from({ length: 56 }, (_, i) => ({ id: `issue-${i}`, bankId: fixtureBanks[1].id, hospitalId: "synthetic", group: "A+", component: "PRBC", quantity: 2, at: new Date(Date.parse(from) + i * DAY_MS).toISOString() }));
function plan(overrides = {}) {
  const stock = units(), weather = bloodWeather(fixtureBanks, stock, history, fixtureBanks.map(b => ({ bankId: b.id, from, until: now })), now, { ...DEFAULT_FORECAST, dengue: false });
  return planRebalancing(fixtureBanks, stock, weather, now, { ...DEFAULT_REBALANCE, ...overrides });
}
it("moves only observed surplus into exact-group/component deficits within capacity", () => {
  expect(plan().transfers).toHaveLength(2); expect(plan({ inboundCapacity: 1 }).transfers).toHaveLength(1); expect(plan({ outboundCapacity: 0 }).transfers).toHaveLength(0);
  expect(plan().transfers.every(t => t.toBankId === fixtureBanks[1].id)).toBe(true);
});
it("excludes routes beyond distance, expiry buffer, or missing demand observation", () => {
  expect(plan({ maxKm: 0 }).transfers).toHaveLength(0); expect(plan({ bufferHours: 48 }).transfers).toHaveLength(1);
  expect(planRebalancing(fixtureBanks, units(), bloodWeather(fixtureBanks, units(), history, [], now), now).transfers).toHaveLength(0);
});
it("applies near-expiry cost and excludes arrival exactly at the expiry buffer boundary", () => {
  expect(plan({ outboundCapacity: 1 }).transfers[0].unitId).toBe("DEMO-001");
  const stock = units().filter(u => u.id === "DEMO-002"), options = { ...DEFAULT_REBALANCE, bufferHours: 48 - travelMinutes(distanceKm(fixtureBanks[0].location, fixtureBanks[1].location)) / 60 };
  const weather = bloodWeather(fixtureBanks, stock, history, fixtureBanks.map(b => ({ bankId: b.id, from, until: now })), now, { ...DEFAULT_FORECAST, dengue: false });
  expect(planRebalancing(fixtureBanks, stock, weather, now, options).transfers).toHaveLength(0);
});
it("planned → in transit → received conserves one unit and retrying cannot deliver twice", () => {
  const stock = units(), transfers = plan().transfers, transfer = transfers[0];
  expect(transfer.status).toBe("PLANNED"); expect(stock.filter(u => readyUnit(u, now)).length).toBe(2);
  dispatchTransfer(transfer, stock, now, transfers); dispatchTransfer(transfer, stock, now, transfers);
  expect(stock.filter(u => readyUnit(u, now, transitIds(transfers))).length).toBe(1);
  expect(stock.find(u => u.id === transfer.unitId)?.bankId).toBe(fixtureBanks[0].id);
  receiveTransfers(transfers, stock, new Date(Date.parse(transfer.arrivesAt) - 1).toISOString()); expect(transfer.status).toBe("IN_TRANSIT");
  receiveTransfers(transfers, stock, transfer.arrivesAt); receiveTransfers(transfers, stock, transfer.arrivesAt);
  expect(transfer.status).toBe("RECEIVED"); expect(stock.filter(u => readyUnit(u, transfer.arrivesAt))).toHaveLength(2); expect(stock.find(u => u.id === transfer.unitId)?.bankId).toBe(fixtureBanks[1].id);
});
it("rechecks ownership, readiness and expiry on dispatch, and fails delayed receipt closed", () => {
  const stock = units(), transfers = plan().transfers;
  stock[0].status = "TESTING"; expect(() => dispatchTransfer(transfers.find(t => t.unitId === stock[0].id)!, stock, now, transfers)).toThrow();
  const t = transfers.find(t => t.unitId === stock[1].id)!; dispatchTransfer(t, stock, now, transfers);
  receiveTransfers(transfers, stock, stock[1].expiresAt); expect(t.status).toBe("EXPIRED"); expect(stock[1].bankId).toBe(fixtureBanks[0].id);
});
