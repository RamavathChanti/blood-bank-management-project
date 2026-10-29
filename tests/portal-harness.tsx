// Served only by the Playwright-owned Vite server. This is outside the Next app.
import { createRoot } from "react-dom/client";
import { PortalWorkflow } from "../src/components/portal-workflows";
import "../src/app/globals.css";
const role = new URLSearchParams(location.search).get("role") === "BANK" ? "BANK" : "HOSPITAL";
createRoot(document.getElementById("root")!).render(<><p>TEST FIXTURE · API responses supplied by Playwright</p><PortalWorkflow role={role} parent={role === "BANK" ? "banks/bank-1" : "hospitals/hospital-1"} onChanged={() => {}} /></>);
