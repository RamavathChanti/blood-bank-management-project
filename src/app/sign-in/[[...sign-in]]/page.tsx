import { SignIn } from "@clerk/nextjs";
import { clerkConfigured } from "@/server/identity";
export const dynamic = "force-dynamic";
export default function Page() { return <><h1>Sign in to the synthetic registry</h1>{clerkConfigured() ? <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" fallbackRedirectUrl="/registry" /> : <p>Clerk login is not configured. Follow the registry setup guide to enable authenticated access.</p>}</>; }
