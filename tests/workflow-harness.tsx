// Actual component, synthetic HTTP fixtures; never served by the Next app.
import { createRoot } from "react-dom/client";
import { DurableCodeRed } from "../src/components/durable-code-red";
import "../src/app/globals.css";
createRoot(document.getElementById("root")!).render(<><p>TEST FIXTURE · API responses supplied by Playwright</p><DurableCodeRed storageKey="test-workflow-fixture" /></>);
