import { RegistryPortal } from "@/components/registry-portal";
import { clerkConfigured } from "@/server/identity";
export const metadata = { title: "Hospital portal" };
export const dynamic = "force-dynamic";
export default function Page() { return <RegistryPortal role="HOSPITAL" configured={clerkConfigured()} />; }
