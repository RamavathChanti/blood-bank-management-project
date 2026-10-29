import { SignUp } from "@clerk/nextjs";
import { clerkConfigured } from "@/server/identity";
export const dynamic = "force-dynamic";
export default function Page() { return <><h1>Create a teaching account</h1><p>New accounts require a server-assigned registry membership before accessing data.</p>{clerkConfigured() ? <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" fallbackRedirectUrl="/registry" /> : <p>Clerk login is not configured.</p>}</>; }
