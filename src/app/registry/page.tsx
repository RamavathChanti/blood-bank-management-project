import { AuditMeter } from "@/components/audit-meter";
import { RegistryPortal } from "@/components/registry-portal";
import { clerkConfigured } from "@/server/identity";
export const metadata = { title: "State registry" };
export const dynamic = "force-dynamic";
export default function Page() { return <><RegistryPortal role="STATE_ADMIN" configured={clerkConfigured()} /><AuditMeter /></>; }
