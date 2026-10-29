import { type Bank, type Donor, GROUPS } from "./domain";
import { donorEligibility } from "./donor-eligibility";
import { distanceKm } from "./emergency-matching";
import type { WeatherRow } from "./forecast";
import * as v from "./validation";

export type CampOptions = { capacity: number; radiusKm: number; turnout: number };
export const DEFAULT_CAMP: CampOptions = { capacity: 8, radiusKm: 25, turnout: .65 };
export type CampPlan = { bankId: string; location: Bank["location"]; score: number; expectedTurnout: number; invitations: { donorId: string; group: Donor["group"]; distanceKm: number; probability: number; scarcity: number }[] };
/** Greedy finite candidate-site selection, not a geographic global optimum.
 * Capacity bounds invitations across ALL sites. One donor creates multiple products,
 * so component deficits use max rather than sum per group. Missing history has no weight. */
export function planCamps(banks: readonly Bank[], donors: readonly Donor[], weather: readonly WeatherRow[], now: string, input = DEFAULT_CAMP, excluded: ReadonlySet<string> = new Set()): CampPlan[] {
  const options = v.object({ capacity: v.number(0, 20, true), radiusKm: v.number(1, 100), turnout: v.number(0, 1) })(input); v.instant(now);
  if (banks.length > 40 || donors.length > 20000) throw new Error("Camp input budget exceeded");
  if (new Set(donors.map(d => d.id)).size !== donors.length || new Set(banks.map(b => b.id)).size !== banks.length) throw new Error("Duplicate camp input identity");
  const eligible = donors.filter(d => !excluded.has(d.id) && donorEligibility(d, now).eligible), used = new Set<string>(), plans: CampPlan[] = [];
  let remaining = options.capacity;
  const candidates = banks.map(bank => ({ bank, weights: Object.fromEntries(GROUPS.map(group => [group, Math.max(0, ...weather.filter(row => row.scope === "BANK" && row.id === bank.id && row.group === group && row.forecast.method !== "MISSING_HISTORY").map(row => Math.max(0, row.forecast.daily.slice(0, 3).reduce((s, day) => s + day.expected, 0) - row.available)))])) as Record<Donor["group"], number> }));
  while (remaining > 0 && candidates.length) {
    const ranked = candidates.map(({ bank, weights }) => {
      const invitations = eligible.filter(d => !used.has(d.id) && weights[d.group] > 0).map(d => {
        const distance = distanceKm(bank.location, d.location), probability = options.turnout * Math.max(.25, 1 - .5 * distance / options.radiusKm);
        return { donorId: d.id, group: d.group, distanceKm: distance, probability, scarcity: weights[d.group] };
      }).filter(d => d.distanceKm <= options.radiusKm).sort((a, b) => b.scarcity * b.probability - a.scarcity * a.probability || a.donorId.localeCompare(b.donorId)).slice(0, remaining);
      return { bankId: bank.id, location: bank.location, invitations, expectedTurnout: invitations.reduce((s, d) => s + d.probability, 0), score: invitations.reduce((s, d) => s + d.probability * d.scarcity, 0) };
    }).sort((a, b) => b.score - a.score || a.bankId.localeCompare(b.bankId));
    const best = ranked[0]; if (!best?.invitations.length) break;
    plans.push(best); remaining -= best.invitations.length; best.invitations.forEach(d => used.add(d.donorId));
    candidates.splice(candidates.findIndex(c => c.bank.id === best.bankId), 1);
  }
  return plans;
}
