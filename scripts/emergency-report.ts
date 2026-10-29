import { createHash } from "node:crypto";
import { commandEmergency, startEmergency, type Emergency, type EmergencyCommand } from "../src/core/emergency";
import { acceptanceProbability, monteCarloAcceptance, sizeWave } from "../src/core/emergency-matching";

const run = (s: Emergency, ...commands: EmergencyCommand[]) => commands.reduce(commandEmergency, s);
const advance = (minutes: number): EmergencyCommand => ({ type: "ADVANCE", minutes });
const stock = run(startEmergency("stock-available"), { type: "DISPATCH" }, advance(60), { type: "HANDOVER" }, { type: "CONFIRM_USE" });
const shortage = run(startEmergency("stock-shortage"), { type: "DISPATCH" }, advance(9));
let recovery = startEmergency("screened-recovery");
const donorId = recovery.alerts[0].donorId;
recovery = run(recovery, { type: "RESPOND", donorId, accepted: true }, { type: "DISPATCH" }, advance(15), { type: "COLLECT", donorId }, advance(45), { type: "HANDOVER" }, { type: "CONFIRM_USE" }, advance(315), { type: "SCREEN", donorId, result: "NON_REACTIVE" }, { type: "DISPATCH" }, advance(60), { type: "HANDOVER" }, { type: "CONFIRM_USE" });
const summarize = (s: Emergency) => ({ status: s.request.status, allocated: s.request.allocatedQuantity, syntheticUse: s.request.transfusedQuantity, quantity: s.request.quantity, elapsedMinutes: (Date.parse(s.now) - Date.parse(s.startedAt)) / 60_000, firstFullStockMatchMinutes: s.matchedAt ? (Date.parse(s.matchedAt) - Date.parse(s.startedAt)) / 60_000 : null, firstAcceptanceMinutes: s.firstAcceptanceAt ? (Date.parse(s.firstAcceptanceAt) - Date.parse(s.startedAt)) / 60_000 : null, waves: s.waves, responses: s.alerts.map(a => ({ donorId: a.donorId, status: a.status })), escalation: s.escalation ?? null, lifecycleEvents: s.events.length, stateSha256: createHash("sha256").update(JSON.stringify(s)).digest("hex"), trace: s.log });
console.log(JSON.stringify({ seed: "monsoon", clock: stock.startedAt, mode: "local synthetic simulation; minutes are simulated, not cloud latency", probabilityAssumption: "Independent equal-p Bernoulli replies; acceptance is not screened stock", probabilityChecks: [1, 2, 4].map(k => { const plan = sizeWave(k, .23, 100); return { ...plan, p: .23, previousNProbability: acceptanceProbability(plan.count - 1, k, .23), monteCarlo: monteCarloAcceptance(plan.count, k, .23, `monsoon-${k}`), trials: 20_000, monteCarloSeed: `monsoon-${k}` }; }), stockAvailable: summarize(stock), stockShortage: summarize(shortage), screenedRecovery: summarize(recovery) }, null, 2));
