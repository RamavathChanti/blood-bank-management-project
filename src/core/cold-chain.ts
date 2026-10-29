import { type Component, type Unit, parseComponent } from "./domain";
import { SeededRandom } from "./random";
import * as v from "./validation";

// Storage, not transport or thawed-product rules. Project shelf lives stay unchanged.
export const STORAGE = {
  PRBC: { min: 2, max: 6, target: 4, label: "Refrigerator · 2–6 °C" },
  PLATELETS: { min: 20, max: 24, target: 22, label: "Agitator · 20–24 °C · continuous gentle agitation" },
  FFP: { min: -80, max: -25, target: -30, label: "Frozen plasma · at or below −25 °C" }
} as const;
export type TemperatureSample = { component: Component; at: string; celsius: number; agitation: boolean; synthetic: true };
export function temperatureSample(seed: string, component: Component, at: string, fault = false): TemperatureSample {
  parseComponent(component); v.instant(at);
  const random = new SeededRandom(`${seed}:${component}:${at}`);
  return { component, at, celsius: +(fault ? STORAGE[component].max + 4 : STORAGE[component].target + random.next() - .5).toFixed(2), agitation: component !== "PLATELETS" || !fault, synthetic: true };
}
export function storageBreach(sample: TemperatureSample) {
  const component = parseComponent(sample.component); v.instant(sample.at); v.number(-100, 100)(sample.celsius); v.boolean(sample.agitation);
  if (sample.synthetic !== true) throw new Error("Synthetic feed required");
  // FFP has no lower clinical threshold here; -80 is a visual scale only.
  return sample.celsius > STORAGE[component].max || component !== "FFP" && sample.celsius < STORAGE[component].min || component === "PLATELETS" && !sample.agitation;
}
export function affectedBySample(unit: Unit, sample: TemperatureSample) {
  return unit.component === sample.component && ["COLLECTED", "TESTING", "AVAILABLE", "RESERVED", "ISSUED", "RETURNED_QUARANTINE"].includes(unit.status) && storageBreach(sample);
}
export function expiryCue(unit: Unit, now: string) {
  const hours = (Date.parse(unit.expiresAt) - Date.parse(v.instant(now))) / 3600000;
  return hours <= 0 ? "Expired" : hours <= 24 ? "Expires within 24 h" : `${Math.floor(hours / 24)} days remaining`;
}
