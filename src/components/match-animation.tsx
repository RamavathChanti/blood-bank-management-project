"use client";
import { useState } from "react";
import type { Component, Group } from "@/core/domain";
export function MatchAnimation({ donor, recipient, component, allowed }: { donor: Group; recipient: Group; component: Component; allowed: boolean }) {
  const [bombay, setBombay] = useState(false), [paused, setPaused] = useState(false);
  const antigens = (group: Group) => [...(group.startsWith("AB") ? ["A", "B"] : group.startsWith("O") ? [] : [group[0]]), ...(group.endsWith("+") ? ["D"] : [])];
  const antibodies = (group: Group) => group.startsWith("AB") ? [] : group.startsWith("O") ? ["anti-A", "anti-B"] : group.startsWith("A") ? ["anti-B"] : ["anti-A"];
  const cellGroup = component === "FFP" ? recipient : donor, plasmaGroup = component === "FFP" ? donor : recipient;
  return <section className="match-animation"><h2>Antigens, antibodies and the teaching reaction</h2><div className="lab-controls"><button className="button button-secondary" aria-pressed={paused} onClick={() => setPaused(!paused)}>{paused ? "Resume reaction animation" : "Pause reaction animation"}</button><label><input type="checkbox" checked={bombay} onChange={e => setBombay(e.target.checked)} /> Optional Bombay-phenotype case</label></div>
    <div className={`reaction ${!allowed || bombay ? "reaction-clumped" : "reaction-clear"} ${paused ? "reaction-paused" : ""}`}>
      <svg viewBox="0 0 600 150" role="img" aria-label={bombay ? "Conceptual anti-H reaction with ordinary O red cells" : component === "PLATELETS" ? "Identical-only platelet teaching policy; no red-cell reaction prediction" : `Conceptual ${allowed ? "separate" : "clustered"} red cells`}>
        {[0, 1, 2, 3, 4].map(i => <g className="reaction-cell" key={i} style={{ transformOrigin: `${90 + i * 100}px 75px`, animationDelay: `${i * -.2}s` }}><ellipse cx={90 + i * 100} cy={75} rx={30} ry={22} fill="#a93854" stroke="#ed8dab" strokeWidth={2} /><text x={90 + i * 100} y={80} textAnchor="middle" fill="#fff" fontSize={14}>{bombay ? "H" : antigens(cellGroup).join(" ") || "H only*"}</text></g>)}
        {(!allowed || bombay) && [0, 1, 2, 3].map(i => <path key={i} d={`M${120 + i * 100} 75h40m-20 0v-14m0 0l-9 -9m9 9l9 -9`} stroke="#ead279" fill="none" strokeWidth={3} />)}
      </svg>
    </div>
    <p role="status">{bombay ? "Isolated exception: a Bombay (Oh) recipient may have anti-H; ordinary O red cells are incompatible. The eight-group registry does not encode this phenotype, so this case cannot be requested or matched." : component === "PLATELETS" ? "Platelets use the stricter identical ABO/RhD project policy. This red-cell illustration does not predict platelet agglutination." : `${component === "FFP" ? "Recipient red-cell" : "Donor red-cell"} antigens: ${antigens(cellGroup).join(", ") || "no A/B/D"}; ${component === "FFP" ? "donor plasma" : "recipient"} ABO antibodies: ${antibodies(plasmaGroup).join(", ") || "no anti-A/anti-B"}. ${allowed ? "No conflict under the simplified rule." : "Rejected by the simplified rule; clustering is a conceptual cue."}`}</p>
    <p className="source-note">*H is a precursor antigen, present on ordinary O cells. RhD-negative does not imply pre-existing anti-D; a RhD rule rejection here illustrates sensitization risk rather than an immediate reaction. ABO/RhD symbols and animated links are conceptual, not a laboratory crossmatch. Motion follows your system preference and can be paused.</p>
    {bombay && <p className="source-note"><a href="https://www.lifeblood.com.au/news-and-stories/health-professionals-news/one-for-all">Lifeblood: Bombay phenotype and anti-H</a>.</p>}
  </section>;
}
