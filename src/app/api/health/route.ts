import { getScaffoldHealth } from "@/server/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(getScaffoldHealth(), { headers: { "Cache-Control": "no-store" } });
}
