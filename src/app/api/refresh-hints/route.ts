import { readDemoFlags } from "@/server/demo-controls";
import { observation, traced } from "@/server/telemetry";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = traced("refresh-hints", async () => {
  const headers = { "Cache-Control": "no-store" };
  try {
    const flags = await readDemoFlags();
    observation("realtime", "hint-gate", 0, !flags.realtimeDown);
    return Response.json({ hintsEnabled: !flags.realtimeDown }, { headers });
  } catch { return Response.json({ hintsEnabled: false }, { status: 503, headers }); }
});
