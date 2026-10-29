import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";

const clerk = clerkMiddleware({ authorizedParties: process.env.CLERK_AUTHORIZED_PARTIES?.split(",").map(value => value.trim()).filter(Boolean) });
export default function proxy(request: NextRequest, event: NextFetchEvent) {
  // The SDK verifies Inngest's signing key; worker callbacks do not use Clerk sessions.
  if (["/api/inngest", "/api/public-board"].includes(request.nextUrl.pathname)) return NextResponse.next();
  // Unconfigured development stays usable for the simulator. Private resources
  // independently fail closed at the identity boundary; no demo auth bypass exists.
  if (!process.env.CLERK_SECRET_KEY || !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) return NextResponse.next();
  return clerk(request, event);
}
export const config = { matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)", "/(api|trpc)(.*)"] };
