import Link from "next/link";

export default function NotFound() {
  return <section className="panel empty-state"><p className="eyebrow">404 / OUTSIDE THE GRID</p><h1>Workspace not found.</h1><p>This route is outside the current pilot.</p><Link className="button button-primary" href="/">Return to Control Room</Link></section>;
}
