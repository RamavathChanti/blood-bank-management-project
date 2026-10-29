import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PulseMap } from "../../src/components/pulse-map";
import { InventoryLab } from "../../src/components/inventory-lab";
import { MatchLab } from "../../src/components/match-lab";
import { CodeRed } from "../../src/components/code-red";
import { WasteLab } from "../../src/components/waste-lab";
import "../../src/app/globals.css";

const scenes = { "Pulse Map": PulseMap, Inventory: InventoryLab, "Match Lab": MatchLab, "Code Red": CodeRed, "Blood Weather": WasteLab };
function Sandbox() {
  const [scene, setScene] = useState<keyof typeof scenes>("Pulse Map");
  const Scene = scenes[scene];
  return <div style={{ maxWidth: 1400, margin: "auto", padding: 24 }}><a className="skip-link" href="#sandbox">Skip to content</a><header><p className="eyebrow">OFFLINE SANDBOX / SYNTHETIC ONLY</p><h1>PulseGrid</h1><p>Teaching model, not clinical software. No accounts or external services. Switching scenes resets their transient state; map configuration persists.</p><nav aria-label="Offline scenes" className="lab-actions">{(Object.keys(scenes) as (keyof typeof scenes)[]).map(name => <button className="button button-secondary" aria-pressed={scene === name} key={name} onClick={() => setScene(name)}>{name}</button>)}</nav></header><main id="sandbox" tabIndex={-1} key={scene}><h2>{scene}</h2><Scene /></main><footer className="app-footer">Teaching model, not clinical software. All timing and records in this sandbox are synthetic.</footer></div>;
}
createRoot(document.getElementById("root")!).render(<Sandbox />);
