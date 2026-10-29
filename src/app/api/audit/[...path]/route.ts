import { auditHandler } from "@/server/audit-api";
export const runtime = "nodejs";
export const maxDuration = 60;
const handler = auditHandler();
export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) { return handler(request, (await context.params).path); }
export const POST = GET;
