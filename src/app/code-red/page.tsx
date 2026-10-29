import { CodeRedModes } from "@/components/durable-code-red";
import { clerkConfigured } from "@/server/identity";
export const metadata = { title: "Code Red" };
export default function Page() { return <CodeRedModes configured={clerkConfigured()} />; }
