import type { SimulationConfig } from "../core/simulation-config";
import type { ScenarioConfig } from "../core/simulation-config";
import type { SimulationSnapshot } from "../core/simulator";

export type SimulationWorkerRequest =
  | { type: "initialize"; seed: string; startedAt: string }
  | { type: "load"; config: ScenarioConfig }
  | { type: "play" | "pause" | "reset" | "replay" }
  | { type: "speed"; speed: number }
  | { type: "advance"; milliseconds: number };
export type SimulationWorkerResponse =
  | { type: "initialized"; config: SimulationConfig }
  | { type: "snapshot"; snapshot: SimulationSnapshot; running: boolean; busy: boolean; speed: number; loaded?: boolean }
  | { type: "error"; message: string };
