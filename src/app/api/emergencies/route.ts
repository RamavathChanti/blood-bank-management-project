import { emergencyHandler } from "@/server/emergency-api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = emergencyHandler();
export async function POST(request: Request) { return handle(request); }
