export const site = {
  name: "PulseGrid",
  qualifier: "College Demo",
  disclaimer: "Teaching model, not clinical software.",
  districts: ["Mumbai City", "Mumbai Suburban", "Thane", "Pune"],
  seed: "monsoon",
  startedAt: "2026-10-28T03:30:00Z"
} as const;

export const features = {
  inventory: { title: "Inventory", section: "Registry", stage: "02", description: "One place for synthetic stock, screening gates, and component lifecycles.", empty: "No units match these filters", detail: "Local fixtures demonstrate FEFO and controlled lifecycle operations. No Atlas registry is connected." },
  "match-lab": { title: "Match Lab", section: "Registry", stage: "02", description: "Explore the teaching rules behind an explainable compatible match.", empty: "Choose a component and recipient", detail: "The interactive grid explains independently tested red-cell, plasma, and identical-only platelet rules." },
  "code-red": { title: "Code Red", section: "Operations", stage: "04", description: "Follow a synthetic emergency from request to an explainable outcome.", empty: "No emergency workflow running", detail: "Local simulation includes stock reservations, donor waves, screening, dispatch and handover. Stage 7 adds durable cloud orchestration." },
  bank: { title: "Bank portal", section: "Portals", stage: "06", description: "A dedicated workspace for synthetic bank inventory and controlled issue.", empty: "Bank access is not configured", detail: "Stage 5 adds server-validated identity and tenant isolation; Stage 6 adds the bank workflow. This scaffold exposes no private bank records." },
  hospital: { title: "Hospital portal", section: "Portals", stage: "06", description: "Create, track, and complete synthetic requests with traceable handover.", empty: "Hospital access is not configured", detail: "Authenticated requests and allocations arrive in Stages 5–6. This scaffold accepts no patient or medical information." },
  duel: { title: "The Duel", section: "Operations", stage: "06", description: "Two hospitals. One synthetic unit. One active owner.", empty: "Choose a reservation model", detail: "An isolated browser fixture explains naive and conditional updates. The real reservation API is checked separately against a MongoDB replica set." },
  "public-board": { title: "Public Board", section: "Registry", stage: "08", description: "A district-level view of availability, with privacy built into the aggregate.", empty: "No public aggregate available", detail: "Cached district, group, and component bands show snapshot age and observed CDN headers. No donor details or exact inventory counts appear." }
} as const;

export type FeatureKey = keyof typeof features;
