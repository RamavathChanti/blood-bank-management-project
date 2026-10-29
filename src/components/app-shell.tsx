"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { features, site } from "@/lib/site";
import { DemoDirector } from "./demo-director";
import { StatusBadge } from "./ui/status-badge";

const groups = [
  { label: "Workspace", links: [{ href: "/try", label: "Things worth trying", icon: "?" }, { href: "/", label: "Control Room", icon: "⌁" }, { href: "/inventory", label: "Inventory", icon: "▤" }, { href: "/match-lab", label: "Match Lab", icon: "⌘" }] },
  { label: "Extras", links: [{ href: "/cold-room", label: "Cold Room", icon: "*" }, { href: "/camp-planner", label: "Camp planner", icon: "+" }, { href: "/intelligence", label: "Intelligence Lab", icon: "i" }] },
  { label: "Operations", links: [{ href: "/surge-lab", label: "Surge Lab", icon: "~" }, { href: "/vital-signs", label: "Vital Signs", icon: "+" }, { href: "/code-red", label: "Code Red", icon: "ϟ" }, { href: "/unit-passport", label: "Unit Passport", icon: "#" }, { href: "/duel", label: "The Duel", icon: "⇄" }, { href: "/waste-lab", label: "Blood Weather", icon: "☂" }, { href: "/public-board", label: "Public Board", icon: "◎" }] },
  { label: "Portals", links: [{ href: "/bank", label: "Bank portal", icon: "⊞" }, { href: "/hospital", label: "Hospital portal", icon: "＋" }, { href: "/donor", label: "Donor portal", icon: "♡" }, { href: "/registry", label: "State registry", icon: "▦" }] }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const title = pathname === "/try" ? "Things worth trying" : pathname === "/cold-room" ? "Cold Room" : pathname === "/camp-planner" ? "Camp planner" : pathname === "/intelligence" ? "Intelligence Lab" : pathname === "/" ? "Control Room" : pathname === "/surge-lab" ? "Surge Lab" : pathname === "/waste-lab" ? "Blood Weather" : pathname === "/unit-passport" ? "Unit Passport" : pathname === "/vital-signs" ? "Vital Signs" : pathname === "/system" ? "System foundation" : pathname === "/registry" ? "State registry" : pathname === "/donor" ? "Donor portal" : features[pathname.slice(1) as keyof typeof features]?.title || "Workspace";
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar">
      <Link href="/" className="brand" aria-label="PulseGrid College Demo home"><span className="brand-symbol" aria-hidden="true">P<span>+</span></span><span>PulseGrid<small>COLLEGE DEMO</small></span></Link>
      <div className="sidebar-divider" />
      <nav aria-label="Main navigation">{groups.map(group => <div className="nav-group" key={group.label}><p className="nav-label">{group.label}</p>{group.links.map(link => <Link key={link.href} className={`nav-link ${pathname === link.href ? "active" : ""}`} href={link.href} aria-current={pathname === link.href ? "page" : undefined}><span className="nav-icon" aria-hidden="true">{link.icon}</span>{link.label}{pathname === link.href && <span className="nav-active-dot" aria-hidden="true" />}</Link>)}</div>)}</nav>
      <div className="sidebar-bottom"><div className="pilot-note"><span className="eyebrow">PILOT REGION</span><strong>Maharashtra, IN</strong><span>Four districts · synthetic data only</span></div><Link href="/system" className={`nav-link ${pathname === "/system" ? "active" : ""}`} aria-current={pathname === "/system" ? "page" : undefined}><span className="nav-icon" aria-hidden="true">⚙</span>System foundation</Link><div className="sidebar-version"><span>FOUNDATION RELEASE</span><span className="mono">v0.1</span></div></div>
    </aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumb"><span>Workspace</span><span aria-hidden="true">/</span><strong>{title}</strong></div><div className="topbar-status"><StatusBadge>{["/bank", "/hospital", "/donor", "/registry"].includes(pathname) ? "Registry workspace" : "Local demo mode"}</StatusBadge><span className="synthetic-label">SYNTHETIC ONLY</span></div></header><main id="main-content" tabIndex={-1}><DemoDirector />{children}</main><footer className="app-footer"><strong>{site.disclaimer}</strong><span>PulseGrid · Centralized Cloud Blood Bank &amp; Emergency Registry · College Demo</span></footer></div>
  </div>;
}
