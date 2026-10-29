// Playwright/Vite-only fixture; never exposed as a production application route.
import { createRoot } from "react-dom/client";
import { useCallback, useState } from "react";
import { PublicBoard } from "../src/components/public-board";
import { PortalWorkflow } from "../src/components/portal-workflows";
import { announceRegistryChange, useLiveRefresh } from "../src/lib/live-updates";
import "../src/app/globals.css";
function Probe() {
  const [value, setValue] = useState("pending");
  const refresh = useCallback(async () => {
    const response = await fetch("/fixture/private");
    if (!response.ok) { setValue("failed"); return false; }
    setValue((await response.json()).status); return true;
  }, []);
  const live = useLiveRefresh(refresh, true, "probe");
  return <><p role="status">{value}</p><p>{live.paused ? "paused" : "active"}</p><button onClick={live.resume}>Resume updates</button><button onClick={announceRegistryChange}>Announce change</button></>;
}
const mode = new URLSearchParams(location.search).get("mode");
createRoot(document.getElementById("root")!).render(<><p>TEST FIXTURE · synthetic API responses supplied by Playwright</p>{mode === "probe" ? <Probe /> : mode === "bank" ? <PortalWorkflow role="BANK" parent="banks/bank-1" onChanged={() => {}} /> : mode === "hospital" ? <PortalWorkflow role="HOSPITAL" parent="hospitals/hospital-1" onChanged={() => {}} /> : <PublicBoard />}</>);
