import Link from "next/link";

export function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-symbol" aria-hidden="true">＋</div><h2>{title}</h2><p>{children}</p><Link className="text-link" href="/">Back to Control Room <span aria-hidden="true">↗</span></Link></div>;
}

export function LoadingState() {
  return <section className="panel loading-state" role="status"><span className="eyebrow">WORKSPACE</span><h1>Loading workspace…</h1><div className="skeleton" aria-hidden="true" /><div className="skeleton short" aria-hidden="true" /><p>Preparing the next view.</p></section>;
}
