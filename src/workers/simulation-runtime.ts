import { createSimulationConfig } from "../core/simulation-config";
import { MAX_DURATION_MS, Simulator, SPEEDS } from "../core/simulator";
import type { SimulationWorkerRequest, SimulationWorkerResponse } from "./protocol";

/** Scheduler-independent worker controller. A timer injects fixed pacing deltas. */
export class SimulationRuntime {
  engine: Simulator | null = null;
  running = false;
  speed = 3600;
  target: number | null = null;
  constructor(private readonly send: (message: SimulationWorkerResponse) => void) {}
  handle(message: SimulationWorkerRequest) {
    try {
      if (message.type === "initialize") { this.send({ type: "initialized", config: createSimulationConfig(message.seed, message.startedAt) }); return; }
      if (message.type === "load") {
        const next = new Simulator(message.config);
        this.engine = next; this.running = false; this.target = null;
        this.publish(true); return;
      }
      if (!this.engine) throw new Error("Load a scenario first");
      switch (message.type) {
        case "play": this.running = this.engine.elapsedMs < MAX_DURATION_MS; this.target = null; break;
        case "pause": this.running = false; this.target = null; break;
        case "speed": if (!(SPEEDS as readonly number[]).includes(message.speed)) throw new Error("Unsupported simulation speed"); this.speed = message.speed; break;
        case "reset": this.engine = new Simulator(this.engine.config); this.running = false; this.target = null; break;
        case "replay": {
          const duration = this.engine.elapsedMs;
          this.engine = new Simulator(this.engine.config); this.running = false; this.target = duration || null; break;
        }
        case "advance":
          if (!Number.isSafeInteger(message.milliseconds) || message.milliseconds <= 0 || this.engine.elapsedMs + message.milliseconds > MAX_DURATION_MS) throw new Error("Advance must fit within the 30-day simulation limit");
          this.running = false; this.target = this.engine.elapsedMs + message.milliseconds; break;
        default: throw new Error("Unsupported worker message");
      }
      this.publish();
    } catch (error) {
      this.running = false; this.target = null;
      this.send({ type: "error", message: error instanceof Error ? error.message : "Simulation command rejected" });
    }
  }
  pump(pacingMilliseconds: number) {
    if (!this.engine || !this.running && this.target === null) return;
    try {
      const delta = this.target !== null ? Math.min(3_600_000, this.target - this.engine.elapsedMs) : Math.min(pacingMilliseconds * this.speed, MAX_DURATION_MS - this.engine.elapsedMs);
      this.engine.advanceBy(delta);
      if (this.engine.elapsedMs === this.target) this.target = null;
      if (this.engine.elapsedMs === MAX_DURATION_MS) this.running = false;
      this.publish();
    } catch (error) {
      this.running = false; this.target = null;
      this.send({ type: "error", message: error instanceof Error ? error.message : "Simulation stopped" });
    }
  }
  private publish(loaded = false) {
    if (this.engine) this.send({ type: "snapshot", snapshot: this.engine.snapshot(), running: this.running, busy: this.target !== null, speed: this.speed, loaded });
  }
}
