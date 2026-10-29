import { parseRequest, parseDonor, type BloodRequest, type LifecycleEvent } from "./domain";
import { DEFAULT_WAVES, matchEmergencyStock, rankDonors, sizeWave, parseWaveConfig, distanceKm, travelMinutes, type AlertProfile, type WaveConfig } from "./emergency-matching";
import { createCollectedUnit, requestWithAllocations, transitionUnit, type UnitCommand } from "./lifecycle";
import { releaseLocalStock } from "./local-registry";
import { CLEAR_SCREENING, FIXTURE_NOW } from "./fixtures";
import { atOffset, generateState, type GeneratedState } from "./state-generator";
import { DEFAULT_SCENARIO } from "./simulation-config";
import { SeededRandom } from "./random";
import * as v from "./validation";

export type EmergencyPreset = "stock-available" | "stock-shortage" | "screened-recovery";
export type Alert = { donorId: string; wave: number; status: "PENDING" | "ACCEPTED" | "DECLINED" | "TIMED_OUT" | "COLLECTED" | "SCREENED" | "REACTIVE" | "CANCELLED"; sentAt: string; closesAt: string; arrivalAt: string; readyAt?: string; unitId?: string };
export type Wave = ReturnType<typeof sizeWave> & { radius: number; openedAt: string; closesAt: string; donorIds: string[] };
export type Emergency = {
  seed: string; now: string; startedAt: string; registry: GeneratedState; profiles: AlertProfile[];
  request: BloodRequest; config: WaveConfig; collectionBankId: string;
  alerts: Alert[]; waves: Wave[]; events: LifecycleEvent[]; log: { at: string; message: string }[];
  dispatched: Record<string, string>; matchedAt?: string; firstAcceptanceAt?: string; escalation?: string;
};
export function emergencyFixture(preset: EmergencyPreset) {
  const registry = generateState({ ...DEFAULT_SCENARIO, scenario: "stock-shortage" });
  // Curated, synthetic eligible donors make each radius and response reproducible.
  const bank = registry.banks[0];
  const profiles: AlertProfile[] = Array.from({ length: 24 }, (_, i) => ({
    donor: parseDonor({ id: `red-donor-${i + 1}`, nickname: `Mock donor ${i + 1}`, group: "O-", location: { latitude: bank.location.latitude + ([2, 7, 18][Math.floor(i / 8)] + (i % 8) * .1) / 111.195, longitude: bank.location.longitude }, birthDate: "1995-01-01", weightKg: 65, haemoglobin: 13.5, donationVolumeMl: 450, eligibleFrom: "2026-01-01T00:00:00.000Z", deferrals: [] }), reliability: .6 + (i % 4) * .1, alertsThisMonth: i % 3
  }));
  registry.donors.push(...profiles.map(p => p.donor));
  return { registry, profiles, request: { hospitalId: registry.hospitals[0].id, group: "O-", component: "PRBC", quantity: preset === "stock-available" ? 1 : 2, urgency: "CRITICAL", expectedTransfusionAt: atOffset(FIXTURE_NOW, (preset === "screened-recovery" ? 720 : 120) * 60_000) } };
}
export function validateEmergencyRequest(input: unknown, registry: GeneratedState, now: string) {
  const fields = v.object({ hospitalId: v.text, group: v.oneOf(["O-", "O+", "A-", "A+", "B-", "B+", "AB-", "AB+"]), component: v.oneOf(["PRBC", "PLATELETS", "FFP"]), quantity: v.number(1, 20, true), urgency: v.oneOf(["ROUTINE", "URGENT", "CRITICAL"]), expectedTransfusionAt: v.instant })(input);
  if (!registry.hospitals.some(h => h.id === fields.hospitalId)) throw new Error("Choose a known synthetic hospital");
  const remaining = Date.parse(fields.expectedTransfusionAt) - Date.parse(v.instant(now));
  if (remaining <= 0 || remaining > 24 * 3_600_000) throw new Error("Expected transfusion must be in the next 24 simulated hours");
  return parseRequest({ ...fields, id: "sim-code-red", allocatedQuantity: 0, transfusedQuantity: 0, status: "OPEN" });
}
const live = (s: Emergency) => ["OPEN", "PARTIAL", "ALLOCATED"].includes(s.request.status);
function note(s: Emergency, message: string) { s.log.push({ at: s.now, message }); }
function change(s: Emergency, id: string, command: UnitCommand) {
  const index = s.registry.units.findIndex(u => u.id === id);
  const result = transitionUnit(s.registry.units[index], command, { now: s.now, actorId: "sim-operator", eventId: `red-event-${s.events.length + 1}` });
  s.registry.units[index] = result.unit; s.events.push(result.event);
}
function release(s: Emergency, mode: "CANCEL" | "EXPIRE") {
  const result = releaseLocalStock(s.registry.units, s.request, s.now, `red-${s.events.length}`, mode);
  s.registry.units = [...result.units]; s.request = result.request; s.events.push(...result.events);
  if (result.events.length) note(s, `${result.events.length} reservation(s) released: ${mode.toLowerCase()}; stock revalidated.`);
}
function match(s: Emergency) {
  const hospital = s.registry.hospitals.find(h => h.id === s.request.hospitalId)!;
  const result = matchEmergencyStock(s.registry.units, s.request, s.registry.banks, hospital, s.now);
  for (const { unit } of result.selected) {
    change(s, unit.id, { type: "RESERVE", request: s.request, allocationId: `red-allocation-${s.events.length}` });
    s.request = requestWithAllocations(s.request, s.request.allocatedQuantity + 1);
    note(s, `${unit.id} reserved: compatible screened stock, bank distance, then FEFO. Ten-minute maximum lease.`);
  }
  if (s.request.allocatedQuantity === s.request.quantity && !s.matchedAt) { s.matchedAt = s.now; note(s, "Full screened-stock match reached; completion still requires dispatch, handover and synthetic use."); }
}
function openWave(s: Emergency) {
  const radius = [5, 10, 25][s.waves.length];
  if (!radius) { escalate(s, "All 5 / 10 / 25 km waves exhausted. Neighbouring-district/manual coordination required; unresolved."); return; }
  const bank = s.registry.banks.find(b => b.id === s.collectionBankId)!;
  const ranked = rankDonors(s.profiles, s.request, bank, s.now, s.config, s.alerts.map(a => a.donorId)).filter(p => !p.reasons.length && p.distance <= radius);
  const opportunities = s.alerts.filter(a => ["ACCEPTED", "COLLECTED"].includes(a.status)).length;
  const required = Math.max(0, s.request.quantity - s.request.allocatedQuantity - opportunities);
  if (!required) return;
  const plan = sizeWave(required, s.config.acceptanceRate, ranked.length, s.config.target);
  const selected = ranked.slice(0, plan.count), closesAt = atOffset(s.now, s.config.waitMinutes * 60_000);
  s.waves.push({ ...plan, radius, openedAt: s.now, closesAt, donorIds: selected.map(p => p.donor.id) });
  for (const profile of selected) {
    s.alerts.push({ donorId: profile.donor.id, wave: s.waves.length, status: "PENDING", sentAt: s.now, closesAt, arrivalAt: atOffset(s.now, profile.eta * 60_000) });
    const stored = s.profiles.find(p => p.donor.id === profile.donor.id)!;
    stored.alertsThisMonth++; stored.lastAlertAt = s.now;
  }
  note(s, `Wave ${s.waves.length}: ${radius} km, ${plan.count} alerts for ${required} donor(s), ${(plan.probability * 100).toFixed(1)}% assumed chance; ${plan.targetMet ? "target met" : "insufficient population / target not met"}. Acceptance is not screened stock.`);
}
function escalate(s: Emergency, reason: string) {
  release(s, "CANCEL"); s.request = parseRequest({ ...s.request, status: "ESCALATED" }); s.escalation = reason;
  for (const alert of s.alerts) if (["PENDING", "ACCEPTED"].includes(alert.status)) alert.status = "CANCELLED";
  note(s, reason);
}
export function startEmergency(preset: EmergencyPreset, input?: unknown, config: WaveConfig = DEFAULT_WAVES): Emergency {
  const fixture = emergencyFixture(preset);
  const s: Emergency = { seed: "monsoon", now: FIXTURE_NOW, startedAt: FIXTURE_NOW, registry: fixture.registry, profiles: fixture.profiles, request: validateEmergencyRequest(input ?? fixture.request, fixture.registry, FIXTURE_NOW), config: parseWaveConfig(config), collectionBankId: fixture.registry.banks[0].id, alerts: [], waves: [], events: [], log: [], dispatched: {} };
  note(s, "Validated synthetic request accepted locally. No cloud persistence or notifications."); match(s);
  if (s.request.allocatedQuantity < s.request.quantity) openWave(s);
  return s;
}
export type EmergencyCommand = { type: "ADVANCE"; minutes: number } | { type: "RESPOND"; donorId: string; accepted: boolean } | { type: "COLLECT"; donorId: string } | { type: "SCREEN"; donorId: string; result: "NON_REACTIVE" | "REACTIVE" } | { type: "DISPATCH"; preparationConfirmed?: boolean } | { type: "HANDOVER" } | { type: "CONFIRM_USE" } | { type: "MATCH" | "CANCEL" | "SEEDED_RESPONSES" };
function tick(s: Emergency) {
  release(s, "EXPIRE");
  if (Date.parse(s.now) >= Date.parse(s.request.expectedTransfusionAt)) { escalate(s, "Expected transfusion deadline reached; unresolved. Issued units require manual review."); return; }
  for (const a of s.alerts) if (a.status === "PENDING" && s.now >= a.closesAt) { a.status = "TIMED_OUT"; note(s, `${a.donorId}: response wait timed out.`); }
  const wave = s.waves.at(-1);
  const opportunities = s.alerts.filter(a => ["ACCEPTED", "COLLECTED"].includes(a.status)).length;
  if (wave && s.now >= wave.closesAt && s.request.quantity > s.request.allocatedQuantity + opportunities) openWave(s);
}
function respond(s: Emergency, donorId: string, accepted: boolean) {
  const alert = s.alerts.find(a => a.donorId === donorId);
  if (!alert || alert.status !== "PENDING" || s.now >= alert.closesAt) throw new Error("Alert is no longer awaiting a response");
  alert.status = accepted ? "ACCEPTED" : "DECLINED";
  if (accepted) {
    s.firstAcceptanceAt ??= s.now;
    const profile = s.profiles.find(p => p.donor.id === donorId)!;
    const bank = s.registry.banks.find(b => b.id === s.collectionBankId)!;
    alert.arrivalAt = atOffset(s.now, travelMinutes(distanceKm(profile.donor.location, bank.location)) * 60_000);
  }
  note(s, `${donorId}: ${accepted ? "accepted collection opportunity; travel and screening remain" : "declined"}.`);
}
export function commandEmergency(input: Emergency, command: EmergencyCommand): Emergency {
  const s = structuredClone(input);
  if (!live(s)) throw new Error("Request is closed; reset to replay");
  switch (command.type) {
    case "ADVANCE":
      v.number(1, 1440, true)(command.minutes);
      for (let i = 0; i < command.minutes && live(s); i++) { s.now = atOffset(s.now, 60_000); tick(s); }
      break;
    case "RESPOND": respond(s, command.donorId, command.accepted); break;
    case "SEEDED_RESPONSES":
      for (const a of s.alerts.filter(a => a.status === "PENDING")) respond(s, a.donorId, new SeededRandom(`${s.seed}:${a.donorId}:${a.sentAt}`).next() < s.config.acceptanceRate);
      break;
    case "COLLECT": {
      const alert = s.alerts.find(a => a.donorId === command.donorId);
      if (!alert || alert.status !== "ACCEPTED" || s.now < alert.arrivalAt) throw new Error("Accepted donor must first reach the collection bank");
      const profile = s.profiles.find(p => p.donor.id === alert.donorId)!;
      const bank = s.registry.banks.find(b => b.id === s.collectionBankId)!;
      if (rankDonors([{ ...profile, alertsThisMonth: 0, lastAlertAt: undefined }], s.request, bank, s.now, { ...s.config, quietStartHour: 0, quietEndHour: 0 })[0].reasons.length) throw new Error("Mock donor eligibility changed before collection");
      const product = s.request.component === "PRBC" ? "PRBC_SAGM" : s.request.component === "FFP" ? "FFP_FROZEN" : "PLATELETS_CLOSED";
      const unit = createCollectedUnit({ id: `red-unit-${alert.donorId}`, donorId: alert.donorId, bankId: bank.id, group: profile.donor.group, component: s.request.component, product, collectedAt: s.now });
      s.registry.units.push(unit); change(s, unit.id, { type: "START_TESTING" });
      profile.donor = { ...profile.donor, lastDonationAt: s.now, eligibleFrom: atOffset(s.now, 120 * 86_400_000) };
      alert.status = "COLLECTED"; alert.unitId = unit.id; alert.readyAt = atOffset(s.now, 360 * 60_000);
      note(s, `${alert.donorId}: synthetic collection; pending tests for six simulated hours. No available stock added.`); break;
    }
    case "SCREEN": {
      const alert = s.alerts.find(a => a.donorId === command.donorId);
      if (!alert || alert.status !== "COLLECTED" || !alert.readyAt || s.now < alert.readyAt) throw new Error("Six-hour mock screening wait has not elapsed");
      change(s, alert.unitId!, { type: "UPDATE_SCREENING", screening: command.result === "REACTIVE" ? { ...CLEAR_SCREENING, HIV: "REACTIVE" } : CLEAR_SCREENING });
      if (command.result === "REACTIVE") { alert.status = "REACTIVE"; note(s, "Reactive mock screening: unit discarded, demand remains unmet."); }
      else { change(s, alert.unitId!, { type: "VERIFY_STORAGE", storage: "VERIFIED" }); change(s, alert.unitId!, { type: "MAKE_AVAILABLE" }); alert.status = "SCREENED"; note(s, "All five mock screens non-reactive; verified storage. Component now eligible for stock search."); match(s); }
      break;
    }
    case "MATCH": match(s); break;
    case "DISPATCH": {
      const reserved = s.registry.units.filter(u => u.status === "RESERVED" && u.reservation?.requestId === s.request.id);
      if (!reserved.length) throw new Error("No active reservation to dispatch; search stock again");
      const hospital = s.registry.hospitals.find(h => h.id === s.request.hospitalId)!;
      for (const unit of reserved) {
        const bank = s.registry.banks.find(b => b.id === unit.bankId)!;
        const arrival = atOffset(s.now, travelMinutes(distanceKm(bank.location, hospital.location)) * 60_000);
        if (arrival > s.request.expectedTransfusionAt) throw new Error("Estimated dispatch arrival exceeds expected transfusion deadline");
        change(s, unit.id, { type: "ISSUE", request: s.request, preparationConfirmed: command.preparationConfirmed }); s.dispatched[unit.id] = arrival;
      }
      note(s, `${reserved.length} unit(s) dispatched. Straight-line travel estimate; no routed ETA.`); break;
    }
    case "HANDOVER": {
      const issued = s.registry.units.filter(u => u.status === "ISSUED" && u.reservation?.requestId === s.request.id && !u.handoverAt);
      if (!issued.length) throw new Error("No dispatched units awaiting handover");
      if (issued.some(u => !s.dispatched[u.id] || s.now < s.dispatched[u.id])) throw new Error("Estimated courier arrival has not elapsed");
      for (const unit of issued) change(s, unit.id, { type: "HANDOVER", requestId: s.request.id });
      note(s, `${issued.length} unit(s) handed over to the synthetic hospital.`); break;
    }
    case "CONFIRM_USE": {
      const ready = s.registry.units.filter(u => u.status === "ISSUED" && u.handoverAt && u.reservation?.requestId === s.request.id);
      if (!ready.length) throw new Error("Record handover before synthetic use");
      for (const unit of ready) change(s, unit.id, { type: "TRANSFUSE", requestId: s.request.id });
      const count = s.request.transfusedQuantity + ready.length;
      s.request = parseRequest({ ...s.request, transfusedQuantity: count, status: count === s.request.quantity ? "COMPLETED" : s.request.status });
      note(s, count === s.request.quantity ? "COMPLETED: every requested unit has handover and synthetic use confirmation." : `Partial fulfilment: ${count}/${s.request.quantity} synthetic use confirmed; shortage remains.`);
      if (!live(s)) for (const a of s.alerts) if (["PENDING", "ACCEPTED"].includes(a.status)) a.status = "CANCELLED";
      break;
    }
    case "CANCEL":
      if (s.registry.units.some(u => u.reservation?.requestId === s.request.id && ["ISSUED", "TRANSFUSED"].includes(u.status))) throw new Error("Dispatched stock requires handover or manual escalation; cancellation is only allowed before dispatch");
      release(s, "CANCEL"); s.request = parseRequest({ ...s.request, status: "CANCELLED" });
      for (const a of s.alerts) if (["PENDING", "ACCEPTED"].includes(a.status)) a.status = "CANCELLED";
      note(s, "Request cancelled before dispatch. Active reservations released; pending alerts cancelled. Collected stock stays quarantined."); break;
  }
  return s;
}
