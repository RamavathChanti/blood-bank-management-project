import type { Bank, Unit } from "./domain";
import { distanceKm, travelMinutes } from "./emergency-matching";
import { readyUnit, type WeatherRow } from "./forecast";
import { DAY_MS } from "./shelf-life";
import * as v from "./validation";

export type FlowEdge = { from: number; to: number; capacity: number; cost: number };
/** Successive shortest augmenting paths with reverse residual edges (Bellman–Ford).
 * Maximizes feasible flow, then minimizes integer cost; deterministic input order breaks ties. */
export function minCostFlow(nodes: number, edges: readonly FlowEdge[], source: number, sink: number) {
  v.number(2, 2500, true)(nodes); v.number(0, nodes - 1, true)(source); v.number(0, nodes - 1, true)(sink);
  if (source === sink) throw new Error("Distinct source and sink required");
  type Edge = { to: number; capacity: number; cost: number; reverse: number };
  const graph: Edge[][] = Array.from({ length: nodes }, () => []), forward: Edge[] = [];
  for (const edge of edges) {
    v.number(0, nodes - 1, true)(edge.from); v.number(0, nodes - 1, true)(edge.to); v.number(0, 10000, true)(edge.capacity); v.number(0, 100000000, true)(edge.cost);
    if (edge.from === edge.to) throw new Error("Self edges are not supported");
    const f = { to: edge.to, capacity: edge.capacity, cost: edge.cost, reverse: graph[edge.to].length };
    const r = { to: edge.from, capacity: 0, cost: -edge.cost, reverse: graph[edge.from].length };
    graph[edge.from].push(f); graph[edge.to].push(r); forward.push(f);
  }
  let flow = 0, cost = 0;
  for (;;) {
    const distances = Array<number>(nodes).fill(Infinity), previous = Array<{ node: number; edge: number } | undefined>(nodes); distances[source] = 0;
    for (let pass = 0; pass < nodes - 1; pass++) {
      let changed = false;
      for (let from = 0; from < nodes; from++) if (Number.isFinite(distances[from])) for (let i = 0; i < graph[from].length; i++) {
        const edge = graph[from][i], next = distances[from] + edge.cost;
        if (edge.capacity > 0 && next < distances[edge.to]) { distances[edge.to] = next; previous[edge.to] = { node: from, edge: i }; changed = true; }
      }
      if (!changed) break;
    }
    if (!previous[sink]) break;
    let quantity = Infinity;
    for (let node = sink; node !== source;) { const p = previous[node]!; quantity = Math.min(quantity, graph[p.node][p.edge].capacity); node = p.node; }
    for (let node = sink; node !== source;) { const p = previous[node]!, edge = graph[p.node][p.edge]; edge.capacity -= quantity; graph[node][edge.reverse].capacity += quantity; node = p.node; }
    flow += quantity; cost += quantity * distances[sink];
  }
  return { flow, cost, edgeFlows: edges.map((edge, i) => edge.capacity - forward[i].capacity) };
}
export type RebalanceOptions = { horizonDays: number; nearExpiryDays: number; bufferHours: number; outboundCapacity: number; inboundCapacity: number; maxKm: number; expiryPenalty: number };
export const DEFAULT_REBALANCE: RebalanceOptions = { horizonDays: 3, nearExpiryDays: 7, bufferHours: 6, outboundCapacity: 12, inboundCapacity: 12, maxKm: 180, expiryPenalty: 60 };
export function rebalanceOptions(input: RebalanceOptions): RebalanceOptions {
  return v.object({ horizonDays: v.number(1, 7, true), nearExpiryDays: v.number(1, 14), bufferHours: v.number(1, 48), outboundCapacity: v.number(0, 50, true), inboundCapacity: v.number(0, 50, true), maxKm: v.number(0, 250), expiryPenalty: v.number(0, 1000) })(input);
}
export type PlannedTransfer = { id: string; unitId: string; fromBankId: string; toBankId: string; plannedAt: string; arrivesAt: string; distanceKm: number; cost: number; status: "PLANNED" | "IN_TRANSIT" | "RECEIVED" | "CANCELLED" | "EXPIRED"; departedAt?: string };
export function planRebalancing(banks: readonly Bank[], units: readonly Unit[], weather: readonly WeatherRow[], now: string, input = DEFAULT_REBALANCE, unavailable: ReadonlySet<string> = new Set()) {
  const options = rebalanceOptions(input); v.instant(now);
  if (banks.length > 40 || units.length > 20000 || new Set(units.map(u => u.id)).size !== units.length || new Set(banks.map(b => b.id)).size !== banks.length) throw new Error("Invalid or oversized rebalancing input");
  const time = Date.parse(now), bankById = new Map(banks.map(b => [b.id, b]));
  const rows = weather.filter(row => row.scope === "BANK" && row.rate.state !== "MISSING_HISTORY");
  const candidates: Unit[] = [], needs: { row: WeatherRow; quantity: number }[] = [];
  for (const row of rows) {
    const stock = units.filter(u => u.bankId === row.id && u.group === row.group && u.component === row.component && readyUnit(u, now, unavailable)).sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt) || a.id.localeCompare(b.id));
    const demand = row.forecast.daily.slice(0, options.horizonDays).reduce((sum, day) => sum + day.expected, 0);
    const quantity = Math.max(0, Math.ceil(demand) - stock.length);
    if (quantity > 0) needs.push({ row, quantity });
    stock.forEach((unit, index) => {
      const daysLeft = (Date.parse(unit.expiresAt) - time) / DAY_MS;
      const localDemand = row.forecast.daily.reduce((sum, day, i) => sum + day.expected * Math.max(0, Math.min(1, daysLeft - i)), 0);
      // Keep the FEFO stock expected to serve local demand before this expiry.
      if (daysLeft <= options.nearExpiryDays && index >= Math.ceil(localDemand)) candidates.push(unit);
    });
  }
  // Reject oversized work explicitly; never silently optimize a truncated graph.
  if (candidates.length > 1000) throw new Error("Rebalancing candidate budget exceeded");
  let next = 1;
  const outbound = new Map(banks.map(bank => [bank.id, next++])), unitNodes = candidates.map(() => next++), needNodes = needs.map(() => next++), inbound = new Map(banks.map(bank => [bank.id, next++])), sink = next++;
  const edges: FlowEdge[] = [], routes: { edge: number; unit: Unit; destination: string; km: number; minutes: number; cost: number }[] = [];
  const edge = (from: number, to: number, capacity: number, cost = 0) => edges.push({ from, to, capacity, cost });
  for (const bank of banks) { edge(0, outbound.get(bank.id)!, options.outboundCapacity); edge(inbound.get(bank.id)!, sink, options.inboundCapacity); }
  needs.forEach((need, i) => edge(needNodes[i], inbound.get(need.row.id)!, Math.min(need.quantity, options.inboundCapacity)));
  candidates.forEach((unit, i) => {
    edge(outbound.get(unit.bankId)!, unitNodes[i], 1);
    needs.forEach((need, j) => {
      if (need.row.id === unit.bankId || unit.group !== need.row.group || unit.component !== need.row.component || !bankById.has(unit.bankId) || !bankById.has(need.row.id)) return;
      const km = distanceKm(bankById.get(unit.bankId)!.location, bankById.get(need.row.id)!.location), minutes = travelMinutes(km);
      const slack = (Date.parse(unit.expiresAt) - time - minutes * 60000 - options.bufferHours * 3600000) / DAY_MS;
      if (km > options.maxKm || slack <= 0) return;
      const cost = Math.round(100 * (minutes + options.expiryPenalty / (slack + .1)));
      routes.push({ edge: edges.length, unit, destination: need.row.id, km, minutes, cost }); edge(unitNodes[i], needNodes[j], 1, cost);
    });
  });
  const solution = minCostFlow(next, edges, 0, sink);
  const transfers: PlannedTransfer[] = routes.filter(route => solution.edgeFlows[route.edge] === 1).map(route => ({ id: `rebalance:${now}:${route.unit.id}`, unitId: route.unit.id, fromBankId: route.unit.bankId, toBankId: route.destination, plannedAt: now, arrivesAt: new Date(time + route.minutes * 60000).toISOString(), distanceKm: route.km, cost: route.cost / 100, status: "PLANNED" }));
  return { transfers, cost: solution.cost / 100, candidates: candidates.length, unmet: needs.reduce((sum, need) => sum + need.quantity, 0) - solution.flow };
}
/** A single unit remains physically owned by the source until receipt; transit IDs
 * are excluded from every bank's available stock and matching pool. */
export function dispatchTransfer(transfer: PlannedTransfer, units: Unit[], now: string, transfers: readonly PlannedTransfer[], bufferHours = 6) {
  v.instant(now); v.number(1, 48)(bufferHours);
  const unit = units.find(unit => unit.id === transfer.unitId);
  if (transfer.status === "IN_TRANSIT" || transfer.status === "RECEIVED") return;
  if (transfer.status !== "PLANNED" || !unit || Date.parse(now) < Date.parse(transfer.plannedAt) || unit.bankId !== transfer.fromBankId || !readyUnit(unit, now) || transfers.some(t => t.id !== transfer.id && t.unitId === unit.id && t.status === "IN_TRANSIT")) throw new Error("Transfer no longer dispatchable");
  const duration = Date.parse(transfer.arrivesAt) - Date.parse(transfer.plannedAt);
  if (Date.parse(unit.expiresAt) <= Date.parse(now) + duration + bufferHours * 3600000) throw new Error("Arrival expiry buffer violated");
  transfer.departedAt = now; transfer.arrivesAt = new Date(Date.parse(now) + duration).toISOString(); transfer.status = "IN_TRANSIT";
}
export function receiveTransfers(transfers: PlannedTransfer[], units: Unit[], now: string) {
  v.instant(now);
  for (const transfer of transfers) if (transfer.status === "IN_TRANSIT" && Date.parse(transfer.arrivesAt) <= Date.parse(now)) {
    const index = units.findIndex(unit => unit.id === transfer.unitId), unit = units[index];
    if (!unit || unit.bankId !== transfer.fromBankId) throw new Error("Transfer ownership mismatch");
    if (Date.parse(unit.expiresAt) <= Date.parse(now) || unit.status === "EXPIRED") { units[index] = { ...unit, status: "EXPIRED" }; transfer.status = "EXPIRED"; }
    else if (!readyUnit(unit, now)) { transfer.status = "CANCELLED"; }
    else { units[index] = { ...unit, bankId: transfer.toBankId }; transfer.status = "RECEIVED"; }
  }
}
export const transitIds = (transfers: readonly PlannedTransfer[]) => new Set(transfers.filter(t => t.status === "IN_TRANSIT").map(t => t.unitId));
