import { createHash } from "node:crypto";
import { runWasteComparison, DEFAULT_WASTE } from "../src/core/waste-simulation";

const started = performance.now(), result = runWasteComparison(DEFAULT_WASTE), replay = runWasteComparison(DEFAULT_WASTE);
const json = JSON.stringify(result), hash = createHash("sha256").update(json).digest("hex");
if (json !== JSON.stringify(replay)) throw new Error("Monthly comparison did not replay identically");
console.log(JSON.stringify({ environment: "Local pure TypeScript; synthetic records only; no Atlas or provider calls", sha256: hash, replayIdentical: true, measuredHostRuntimeMs: Math.round(performance.now() - started), result }, null, 2));
