import { AuditMeter } from "@/components/audit-meter";
import Link from "next/link";
import { PulseMap } from "@/components/pulse-map";
import { PublicBoard } from "@/components/public-board";

export default function Home() {
  return <><div className="page-heading"><div><p className="eyebrow">CONTROL ROOM / MAHARASHTRA PILOT</p><h1>A network with a pulse.</h1><p className="page-description">Follow synthetic supply and demand across four districts.<br />One seed. An explicit clock. A repeatable story.</p></div><Link className="button button-secondary" href="/inventory">Explore local inventory <span aria-hidden="true">↗</span></Link></div><PulseMap /><PublicBoard compact /><AuditMeter /></>;
}
