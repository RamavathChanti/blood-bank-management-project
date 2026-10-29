import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DEFAULT_SCENARIO, PRESETS } from "../src/core/simulation-config";
import { Simulator } from "../src/core/simulator";
import { DAY_MS } from "../src/core/shelf-life";

// Local measurement only. No network, credentials, generated files, or registry access.
const reports = (Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map(preset => {
  const start = performance.now(), simulation = new Simulator({ ...DEFAULT_SCENARIO, preset });
  const generatedMs = performance.now() - start;
  simulation.advanceBy(30 * DAY_MS);
  const snapshot = simulation.snapshot();
  return { preset, seed: DEFAULT_SCENARIO.seed, clock: DEFAULT_SCENARIO.startedAt, durationDays: 30, initial: PRESETS[preset], storage: snapshot.storage, generatedMs: +generatedMs.toFixed(2), monthRuntimeMs: +(performance.now() - start).toFixed(2), final: snapshot.counts, metrics: snapshot.metrics, replaySha256: createHash("sha256").update(JSON.stringify(simulation.exportState())).digest("hex") };
});
process.stdout.write(JSON.stringify({ runtime: process.version, mode: "local simulation; timing is host-specific, not cloud performance", reports }, null, 2) + "\n");
