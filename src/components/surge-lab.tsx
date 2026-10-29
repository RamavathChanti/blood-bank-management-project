"use client";

import { useEffect, useState } from "react";
import { surgeScenario, surgeTick, surgeMetrics, SURGE_LIMITS, type SurgeState } from "@/core/surge";
import { COST_LIMITS, costProjection } from "@/core/cost-limits";
import evidence from "@/data/surge-evidence.json";

const fmt = (n: number | null, digits = 0) => n === null ? "Unavailable" : n.toLocaleString("en-US", { maximumFractionDigits: digits });
const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

export function SurgeLab() {
  const [count, setCount] = useState<number>(SURGE_LIMITS.defaultRequests), [slots, setSlots] = useState(2), [priority, setPriority] = useState(true);
  const [state, setState] = useState<SurgeState | null>(null), [running, setRunning] = useState(false), [error, setError] = useState("");
  const [executions, setExecutions] = useState<number>(COST_LIMITS.assumptions.executionsPerRequest), [pollSeconds, setPollSeconds] = useState<number>(COST_LIMITS.assumptions.bankPollSeconds);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setState(s => s && !s.jobs.every(j => j.finishedMs !== null) ? surgeTick(s) : s), 100);
    return () => clearInterval(timer);
  }, [running]);
  const metrics = state && surgeMetrics(state);
  const complete = Boolean(metrics && metrics.completed === metrics.acknowledged);
  function start() {
    try { setState(surgeScenario(count, slots, priority)); setError(""); setRunning(true); } catch (e) { setError(e instanceof Error ? e.message : "Invalid scenario"); }
  }
  let cost: ReturnType<typeof costProjection> | null = null;
  try { if (!Number.isInteger(executions) || executions < 1 || executions > 1000 || !Number.isInteger(pollSeconds) || pollSeconds < 5 || pollSeconds > 3600) throw new Error("Invalid assumptions"); cost = costProjection({ ...COST_LIMITS.assumptions, executionsPerRequest: executions, bankPollSeconds: pollSeconds }); } catch { /* Keep invalid editable inputs visible. */ }
  return <div className="surge-lab">
    <div className="page-heading"><div><p className="eyebrow">SURGE, PRIORITY &amp; COST · STAGE 13</p><h1>Surge Lab</h1><p>Watch the backlog. Protect the database. Explain the bill.</p></div></div>
    <div className="simulation-banner"><span className="simulation-beacon" /><div><strong>BOUNDED MASS-CASUALTY MODEL · SYNTHETIC ONLY</strong><p>The interactive queue runs in this browser. Recorded local-service measurements appear separately below. Teaching model, not clinical software.</p></div></div>
    <section className="panel lab-panel" aria-label="Bounded surge scenario"><h2>Run a controlled burst</h2>
      <p>Later critical cases move ahead of queued urgent cases. Existing work keeps its slot. The model assumes an 800 ms step; it does not predict cloud latency.</p>
      <form onSubmit={e => { e.preventDefault(); start(); }}><fieldset className="surge-inputs" disabled={running && !complete}>
        <label>Requests<input type="number" required min={4} max={20} step={1} value={count} onChange={e => setCount(e.target.valueAsNumber)} /></label>
        <label>Executing step slots<select value={slots} onChange={e => setSlots(Number(e.target.value))}><option value={1}>1 · serial</option><option value={2}>2 · protected parallel work</option></select></label>
        <label className="surge-check"><input type="checkbox" checked={priority} onChange={e => setPriority(e.target.checked)} /> Prioritize critical cases (+120 seconds of queue age)</label>
      </fieldset><div className="lab-controls"><button className="button button-primary" disabled={running && !complete} type="submit">Run bounded surge</button><button className="button" type="button" disabled={!running || complete} onClick={() => { setRunning(false); setState(s => s ? { ...s, stopped: true } : s); }}>Stop surge</button><button className="button" type="button" onClick={() => { setRunning(false); setState(null); setError(""); }}>Reset surge</button></div></form>
      {error && <p role="alert">{error}</p>}
      <p className="source-note">Hard cap: 20 model requests / 2 executing steps, below the verified free account limits of 5 concurrent Inngest steps and 100,000 queued items. This is a project guardrail, not a guarantee of remaining quota. Stop freezes this model; Reset clears it. Neither control changes the registry or retracts an acknowledged workflow.</p>
      <p role="status">{complete ? "Simulation complete" : state?.stopped ? "Simulation stopped; unfinished jobs retained until reset" : running ? "Simulation running" : "Ready for a bounded surge"}</p>
      {state && metrics && <><div className="surge-meters">{[["Model acknowledgements", metrics.acknowledged], ["Executing", metrics.active], ["Queued", metrics.queued], ["Step completions", metrics.completed], ["Peak executing", state.peakActive], ["Model p95 (ms)", fmt(metrics.p95Ms)], ["Model throughput (/s)", fmt(metrics.throughput, 2)]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
        <div className="surge-queue" aria-label="Synthetic queue">{state.jobs.map(j => <article key={j.id} className={`surge-job ${j.urgency.toLowerCase()}`}><strong>{j.id}</strong><span>{j.urgency}</span><span>{j.finishedMs !== null ? "Step complete" : j.startedMs !== null ? "Executing" : j.enqueuedMs > state.nowMs ? "Scheduled arrival" : "Queued"}</span><small>{j.startedMs === null ? "Waiting for slot" : `Started at ${fmt(j.startedMs)} model ms`}</small></article>)}</div>
      </>}
    </section>
    <section className="panel lab-panel" aria-label="Recorded local service evidence"><p className="eyebrow">MEASURED LOCAL SERVICE · {evidence.measuredAt.slice(0, 10)}</p><h2>Actual queue behavior</h2>
      <p>{evidence.environment}. These are retained measurements from the replay command in the surge guide; running the browser model does not update them.</p>
      <div className="surge-table-wrap"><table className="surge-table"><caption>Identical eight-job probe, including an initial enqueue hold and injected 800 ms work per job</caption><thead><tr>{["Queue policy", "Peak executing", "HTTP callbacks", "DB commands", "Pending before release", "Throughput /s", "p95 end-to-end ms", "Critical p95 ms"].map(t => <th key={t} scope="col">{t}</th>)}</tr></thead><tbody>{evidence.comparisons.map(r => <tr key={r.mode}><th scope="row">{r.mode}</th><td>{r.peakActive}</td><td>{r.callbackInvocations}</td><td>{r.databaseCommands}</td><td>{r.pendingBeforeRelease}</td><td>{fmt(r.throughputPerSecond, 2)}</td><td>{fmt(r.p95EndToEndMs)}</td><td>{fmt(r.p95CriticalMs)}</td></tr>)}</tbody></table></div>
      <p className="source-note">Throughput counts all eight jobs from hold release to final completion. p95 uses nearest rank over enqueue-to-step-completion samples and includes the initial hold. DB commands are driver-observed pings in the queue probe, not Atlas opscounter. HTTP callbacks are observed local requests, not billable Vercel invocations. Provider queue depth, cloud instance count and Atlas ops/s are unavailable.</p>
      <p>Shared guard check: {evidence.sharedGuard.acknowledged} acknowledged probes across {evidence.sharedGuard.functions} functions reached a combined peak of {evidence.sharedGuard.peakExecuting} executing steps using the production environment key. Emergency, signal, push, forecast and audit functions now use this same two-slot guard.</p>
      <h3>Production workflow reconciliation</h3><p>{evidence.production.acknowledged} distinct durable acknowledgements; {evidence.production.cancelled} cancelled, {evidence.production.escalated} escalated, {evidence.production.fulfilled} fulfilled. Identical intake was replayed for every ID. Four units were reserved, then released by explicit stop/escalation signals.</p>
      <p>{evidence.production.duplicateAllocations} duplicate allocations; {evidence.production.activeAllocationsAfterDrain} active allocations after drain; {evidence.production.availableAfterDrain} units available again. Stock and request counters agree. Escalation and cancellation are accounted outcomes; neither means fulfilment.</p>
      <details><summary>Inspect acknowledged IDs and outcomes</summary><ul>{evidence.production.rows.map(r => <li className="surge-id" key={r.requestId}><code>{r.requestId}</code> · {r.outcome}</li>)}</ul></details>
      <p className="source-note">The probe uses the real Inngest scheduler with a small test adapter and the production priority expression. The twelve-request correctness burst uses the production emergency intake, orchestration, signals, transactions and unique indexes. The local service does not demonstrate Vercel fleet scaling or Atlas throttling.</p>
    </section>
    <section className="panel lab-panel" aria-label="Cost and limits projection"><p className="eyebrow">OFFICIAL LIST PRICES CHECKED {COST_LIMITS.checkedOn} · USD</p><h2>300 banks, 1,000 requests a day</h2>
      <div className="surge-inputs"><label>Estimated executions per request<input type="number" min={1} max={1000} step={1} value={executions} onChange={e => setExecutions(e.target.valueAsNumber)} /></label><label>Bank polling interval (seconds)<input type="number" min={5} max={3600} step={1} value={pollSeconds} onChange={e => setPollSeconds(e.target.valueAsNumber)} /></label></div>
      {!cost ? <p role="alert">Enter finite positive cost assumptions.</p> : <><div className="surge-meters"><div><span>Estimated monthly requests</span><strong>{fmt(cost.requests)}</strong></div><div><span>Estimated executions</span><strong>{fmt(cost.executions)}</strong></div><div><span>Estimated API invocations</span><strong>{fmt(cost.invocations)}</strong></div><div><span>Paid base starting floor / month</span><strong>{money(cost.paidBaseFloorUSD)}</strong></div></div>
        <p>At {executions} estimated executions per request, the free workflow allowance covers approximately {fmt(cost.freeExecutionDays, 2)} days. {cost.executions > COST_LIMITS.inngest.freeExecutions ? "This workload exceeds the free execution budget." : "This estimate fits the free execution budget; other limits still apply."} Polling alone contributes {fmt(cost.polling)} API invocations/month.</p>
        <p>Planning assumptions: 30 days; 300 bank screens active 8 hours/day; 35 workflow/API invocations and 200 database commands per emergency; 20 ms CPU and 200 ms wall time at 1 GB per invocation; one developer seat. All workload inputs are estimates. Estimated CPU {fmt(cost.cpuHours, 2)} hours, memory {fmt(cost.memoryGBHours, 2)} GB-hours, and database commands {fmt(cost.estimatedDbCommands)} per month. The database estimate is not an Atlas throughput measurement.</p>
        <p>The {money(cost.paidBaseFloorUSD)} starting floor combines Vercel Pro ({money(COST_LIMITS.vercel.proSeatMonthly)}), Atlas Dedicated (from {money(COST_LIMITS.atlas.dedicatedStartingMonthly)}) and Inngest Pro ({money(COST_LIMITS.inngest.proMonthly)}). Optional Ably adds {money(cost.optionalAblyBaseUSD)} base plus messages, connection and channel minutes; the current app uses polling. Gross compute at published starting rates is approximately {money(cost.grossComputeListEstimateUSD)} before credits or allowances; it is not added to the base floor as an invoice.</p></>}
      <div className="surge-table-wrap"><table className="surge-table"><caption>Published limits and next scaling steps</caption><thead><tr><th>Service</th><th>Free constraint</th><th>Next step</th></tr></thead><tbody>
        <tr><th><a href={COST_LIMITS.inngest.source}>Inngest</a></th><td>50,000 executions/month; 5 concurrent steps</td><td>Reduce wake/step amplification; Pro starts at $99 with 1M executions</td></tr>
        <tr><th><a href={COST_LIMITS.atlas.limitsSource}>Atlas</a></th><td>100 read/write ops/s; 500 connections; 512 MB including indexes</td><td>Measure server opscounter, tune queries; evaluate a dedicated cluster</td></tr>
        <tr><th><a href={COST_LIMITS.vercel.source}>Vercel</a></th><td>1M invocations; 4 CPU hours; 360 GB-hours memory</td><td>Reduce polling; budget Pro seats, region and actual metered usage</td></tr>
        <tr><th><a href={COST_LIMITS.ably.source}>Ably (optional)</a></th><td>200 connections; 6M messages/month</td><td>300 simultaneous banks exceed 200; Standard base $29 plus usage</td></tr>
        <tr><th><a href={COST_LIMITS.clerk.source}>Clerk</a></th><td>50,000 retained users; 100 retained organizations</td><td>Current tenancy uses app metadata; 300 Clerk organizations would need a separate paid estimate</td></tr>
      </tbody></table></div>
      <p>Measured local bottleneck: the configured executing-step slots build a backlog. Likely monthly constraint under these assumptions: workflow execution allowance; frequent polling also exceeds Hobby invocations. Hosted data may identify a different first limit. A two-step concurrency cap cannot enforce 100 database operations/second across steps, APIs, scheduled jobs and processes.</p>
      <p className="source-note">This is a partial planning estimate. Region-specific compute, storage growth, transfer, taxes, retries, scheduled audit/forecast work, audience traffic, authentication upgrades and overages require actual account measurements. Hobby eligibility is restricted to personal non-commercial use. Prices and account entitlements can change. No unlimited elasticity or guaranteed zero-cost claim.</p>
    </section>
  </div>;
}
