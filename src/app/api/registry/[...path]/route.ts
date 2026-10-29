import { registryHandler } from "@/server/registry-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = registryHandler();
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, context: Context) { return handle(request, (await context.params).path); }
export async function PATCH(request: Request, context: Context) { return handle(request, (await context.params).path); }
export async function POST(request: Request, context: Context) { return handle(request, (await context.params).path); }
