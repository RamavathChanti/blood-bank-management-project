import { resilienceHandler } from "@/server/resilience-api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = resilienceHandler();
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, context: Context) { return handle(request, (await context.params).path); }
export async function POST(request: Request, context: Context) { return handle(request, (await context.params).path); }
