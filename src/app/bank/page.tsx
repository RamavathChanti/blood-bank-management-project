import { RegistryPortal } from "@/components/registry-portal";
import { clerkConfigured } from "@/server/identity";
export const metadata = { title: "Bank portal" };
export const dynamic = "force-dynamic";
export default function Page() { return <RegistryPortal role="BANK" configured={clerkConfigured()} />; }
