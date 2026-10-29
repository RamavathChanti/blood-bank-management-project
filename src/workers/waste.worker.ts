/// <reference lib="webworker" />
import { finishComparison, makeWasteTape, wasteConfig, WasteRun, WASTE_POLICIES, type PolicyResult, type WasteConfig } from "../core/waste-simulation";

// Each run yields between simulated days; terminating the worker cancels all work.
self.onmessage = async (event: MessageEvent<WasteConfig>) => {
  try {
    const config = wasteConfig(event.data), tape = makeWasteTape(config), results: PolicyResult[] = [];
    for (const policy of WASTE_POLICIES) {
      const run = new WasteRun(policy, tape, config);
      for (let day = 1; day <= 30; day++) {
        run.advanceDay(); self.postMessage({ type: "progress", policy, day, completed: results.length * 30 + day });
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      results.push(run.result());
    }
    self.postMessage({ type: "complete", result: finishComparison(config, tape, results) });
  } catch (error) { self.postMessage({ type: "error", message: error instanceof Error ? error.message : "Comparison failed" }); }
};
