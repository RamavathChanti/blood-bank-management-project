"use client";

import { useEffect, useRef, useState } from "react";
import { site } from "@/lib/site";
import type { SimulationWorkerRequest, SimulationWorkerResponse } from "@/workers/protocol";

export function WorkerCheck() {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const workerRef = useRef<Worker | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cleanup() {
    workerRef.current?.terminate();
    workerRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }

  useEffect(() => cleanup, []);

  function checkWorker() {
    cleanup();
    setState("loading");
    try {
      const worker = new Worker(new URL("../workers/simulation.worker.ts", import.meta.url), { type: "module" });
      workerRef.current = worker;
      const fail = () => { cleanup(); setState("error"); };
      worker.onerror = fail;
      worker.onmessageerror = fail;
      worker.onmessage = ({ data }: MessageEvent<SimulationWorkerResponse>) => {
        cleanup();
        setState(data.type === "initialized" ? "ready" : "error");
      };
      timerRef.current = setTimeout(fail, 10_000);
      worker.postMessage({ type: "initialize", seed: site.seed, startedAt: site.startedAt } satisfies SimulationWorkerRequest);
    } catch {
      cleanup();
      setState("error");
    }
  }

  return <section className="panel system-card"><p className="eyebrow">BROWSER ISOLATION</p><h2>Worker handshake</h2><p>Initialize the separate simulation worker with a fixed seed and clock. This checks setup only; no simulation is running and no registry is written.</p><dl className="config-list"><div><dt>Seed</dt><dd>{site.seed}</dd></div><div><dt>Teaching clock</dt><dd>28 Oct 2026 · 09:00 IST</dd></div></dl><button className="button button-secondary" disabled={state === "loading"} onClick={checkWorker}>{state === "loading" ? "Checking worker…" : "Check worker"}</button><p className={`worker-result ${state === "error" ? "error-text" : ""}`} role="status" aria-live="polite">{state === "idle" ? "Worker has not been checked in this browser." : state === "loading" ? "Initializing the browser worker…" : state === "ready" ? "Worker ready · fixed seed and clock received." : "Worker unavailable. Try again in a browser that supports Web Workers."}</p></section>;
}
