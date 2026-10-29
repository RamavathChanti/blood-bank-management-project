import { SimulationRuntime } from "./simulation-runtime";
import type { SimulationWorkerRequest, SimulationWorkerResponse } from "./protocol";

const worker = self as unknown as {
  onmessage: (event: MessageEvent<SimulationWorkerRequest>) => void;
  postMessage: (response: SimulationWorkerResponse) => void;
};

const runtime = new SimulationRuntime(response => worker.postMessage(response));
let replayTimer: ReturnType<typeof setTimeout> | null = null;
function continueReplay() {
  if (runtime.target === null || replayTimer !== null) return;
  replayTimer = setTimeout(() => {
    replayTimer = null;
    runtime.pump(0);
    continueReplay();
  }, 0);
}
worker.onmessage = ({ data }) => { runtime.handle(data); continueReplay(); };
// Pacing controls how often work is requested, never the simulated event clock.
setInterval(() => runtime.pump(250), 250);
