import { COMPONENTS, GROUPS, type Component, type Group } from "./domain";
import type { WeatherRow } from "./forecast";
import { emergencyInput } from "./workflow-events";
import * as v from "./validation";

const nullable = <T>(parser: v.Parser<T>): v.Parser<T | null> => value => value === null ? null : parser(value);
const shortText = (value: unknown) => { const text = v.text(value); if (text.length > 200) throw new Error("Text too long"); return text; };
export const parseIntakeDraft = v.object({ group: nullable(v.oneOf(GROUPS)), component: nullable(v.oneOf(COMPONENTS)), quantity: nullable(v.number(1, 20, true)), urgency: nullable(v.oneOf(["URGENT", "CRITICAL"])), expectedTransfusionAt: nullable(v.instant), uncertainties: (value: unknown) => { const entries = v.array(shortText)(value); if (entries.length > 6) throw new Error("Too many uncertainties"); return entries; } });
export type IntakeDraft = ReturnType<typeof parseIntakeDraft>;
export const INTAKE_SCHEMA = { type: "object", additionalProperties: false, required: ["group", "component", "quantity", "urgency", "expectedTransfusionAt", "uncertainties"], properties: { group: { type: ["string", "null"], enum: [...GROUPS, null] }, component: { type: ["string", "null"], enum: [...COMPONENTS, null] }, quantity: { type: ["integer", "null"], minimum: 1, maximum: 20 }, urgency: { type: ["string", "null"], enum: ["URGENT", "CRITICAL", null] }, expectedTransfusionAt: { type: ["string", "null"] }, uncertainties: { type: "array", items: { type: "string" }, maxItems: 6 } } };
export function confirmIntake(draft: IntakeDraft, now: string) {
  const parsed = parseIntakeDraft(draft), input = emergencyInput({ key: "confirmed-draft", group: parsed.group, component: parsed.component, quantity: parsed.quantity, urgency: parsed.urgency, expectedTransfusionAt: parsed.expectedTransfusionAt });
  const until = Date.parse(input.expectedTransfusionAt) - Date.parse(v.instant(now));
  if (until <= 0 || until > 86400000) throw new Error("Expected use must be within the next 24 hours");
  return input;
}
/** Offline dictionary demonstration, explicitly not AI. Ambiguity stays empty.
 * Only explicit ABO/Rh symbols, product words, unit counts and hours are recognized. */
export function dictionaryIntake(text: string, now: string): IntakeDraft {
  if (!text.trim() || text.length > 600) throw new Error("Use 1–600 characters"); v.instant(now);
  const groups = [...text.toUpperCase().matchAll(/(?<![A-Z0-9])(?:AB|A|B|O)[+-](?![A-Z0-9])/g)].map(m => m[0] as Group);
  const components: Component[] = [];
  if (/PRBC|red cells?|लाल रक्त/i.test(text)) components.push("PRBC");
  if (/platelets?|प्लेटलेट/i.test(text)) components.push("PLATELETS");
  if (/FFP|plasma|प्लाज्मा/i.test(text)) components.push("FFP");
  const quantities = [...text.matchAll(/(\d+)\s*(?:units?|यूनिट)/gi)].map(m => Number(m[1]));
  const hours = [...text.matchAll(/(\d+)\s*(?:hours?|ghante|घंटे)/gi)].map(m => Number(m[1]));
  const unique = <T,>(values: T[]) => new Set(values).size === 1 ? values[0] : null;
  const quantity = unique(quantities), hour = unique(hours), critical = /critical|गंभीर/i.test(text), urgent = /urgent|तुरंत|jaldi/i.test(text);
  const draft = { group: unique(groups), component: unique(components), quantity: quantity && quantity <= 20 ? quantity : null, urgency: critical && urgent ? null : critical ? "CRITICAL" as const : urgent ? "URGENT" as const : null, expectedTransfusionAt: hour && hour <= 24 ? new Date(Date.parse(now) + hour * 3600000).toISOString() : null, uncertainties: ["Offline dictionary example; negation and natural language context are not understood. Review every field."] };
  return parseIntakeDraft(draft);
}
export const OPS_TEMPLATES = ["SHORTAGES", "UNKNOWN_HISTORY", "TRANSFER_SUMMARY"] as const;
export type OpsTemplate = typeof OPS_TEMPLATES[number];
export function opsAnswer(template: OpsTemplate, weather: readonly WeatherRow[], transfers: readonly { unitId: string }[]) {
  v.oneOf(OPS_TEMPLATES)(template);
  const rows = weather.filter(row => row.scope === "BANK" && (template === "SHORTAGES" ? row.weather === "STORM" || row.weather === "WATCH" : template === "UNKNOWN_HISTORY" ? row.weather === "UNKNOWN" : false)).map(row => ({ bankId: row.id, group: row.group, component: row.component, available: row.available, weather: row.weather, forecastMethod: row.forecast.method }));
  return { template, summary: template === "TRANSFER_SUMMARY" ? `${transfers.length} proposed transfers; ${new Set(transfers.map(t => t.unitId)).size} proposed component units. No transfer executed.` : `${rows.length} matching bank/group/component aggregates.`, rows, limits: "Snapshot only. Missing history is unknown. Forecasts are teaching estimates. No donor records, arbitrary queries or mutation tools." };
}
