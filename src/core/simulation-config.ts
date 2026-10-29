export type SimulationConfig = Readonly<{ seed: string; startedAt: string }>;

/** Pure setup only. No wall clock, registry writes, RNG, or simulation ticks. */
export function createSimulationConfig(seed: string, startedAt: string): SimulationConfig {
  const normalizedSeed = seed.trim();
  if (!normalizedSeed) throw new Error("A non-empty seed is required.");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(startedAt)) {
    throw new Error("The simulation clock must include an explicit timezone.");
  }
  const timestamp = Date.parse(startedAt);
  // Reject normalized calendar overflows such as February 30, not just NaN.
  const datePart = startedAt.slice(0, 10);
  const calendarDate = new Date(`${datePart}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || !Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== datePart) {
    throw new Error("The simulation clock must be a valid date.");
  }
  return Object.freeze({ seed: normalizedSeed, startedAt: new Date(timestamp).toISOString() });
}

export const PRESETS = {
  development: { banks: 4, hospitals: 4, donors: 200, units: 120, historicalIssues: 112, requestsPerDay: 24, donationsPerDay: 12 },
  demo: { banks: 20, hospitals: 50, donors: 5000, units: 900, historicalIssues: 840, requestsPerDay: 180, donationsPerDay: 70 }
} as const;
export const SCENARIOS = ["monsoon", "last-o-negative", "stock-shortage", "near-expiry", "dengue-season"] as const;
export type ScenarioName = typeof SCENARIOS[number];
export type ScenarioConfig = SimulationConfig & Readonly<{ version: 1; preset: keyof typeof PRESETS; scenario: ScenarioName }>;
export const DEFAULT_SCENARIO: ScenarioConfig = { version: 1, seed: "monsoon", startedAt: "2026-10-28T03:30:00.000Z", preset: "development", scenario: "monsoon" };
export const CONFIG_STORAGE_KEY = "pulsegrid.simulation.v1";

/** Strict persisted configuration; ignore/reject old, unknown, or unbounded options. */
export function parseScenarioConfig(value: unknown): ScenarioConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid scenario configuration");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["version", "seed", "startedAt", "preset", "scenario"].includes(key)) || input.version !== 1 || typeof input.seed !== "string" || input.seed.length > 80 || typeof input.startedAt !== "string" || typeof input.preset !== "string" || !Object.hasOwn(PRESETS, input.preset) || !SCENARIOS.includes(input.scenario as ScenarioName)) throw new Error("Invalid scenario configuration");
  const clock = createSimulationConfig(input.seed, input.startedAt);
  if (Date.parse(clock.startedAt) < Date.parse("2020-01-01T00:00:00Z") || Date.parse(clock.startedAt) > Date.parse("2100-01-01T00:00:00Z")) throw new Error("Choose a teaching clock between 2020 and 2100");
  return Object.freeze({ ...clock, version: 1, preset: input.preset as keyof typeof PRESETS, scenario: input.scenario as ScenarioName });
}
