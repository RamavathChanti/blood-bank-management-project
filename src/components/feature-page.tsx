import { features, type FeatureKey } from "@/lib/site";
import { EmptyState } from "./ui/states";
import { StatusBadge } from "./ui/status-badge";

export function FeaturePage({ feature }: { feature: FeatureKey }) {
  const item = features[feature];
  return <><div className="page-heading"><div><p className="eyebrow">{item.section.toUpperCase()} / FOUNDATION</p><h1>{item.title}</h1><p className="page-description">{item.description}</p></div><StatusBadge>Planned · Stage {item.stage}</StatusBadge></div><section className="panel feature-panel"><div className="panel-heading"><span className="eyebrow">WORKSPACE PREVIEW</span><span className="mono muted">NO LIVE DATA</span></div><EmptyState title={item.empty}>{item.detail}</EmptyState></section><div className="notice"><span aria-hidden="true">ⓘ</span><p>Navigation and shared states are ready. This screen is a foundation for a later stage; no registry operation is available here yet.</p></div></>;
}
