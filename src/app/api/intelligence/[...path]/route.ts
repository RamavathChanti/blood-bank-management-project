import { intelligenceHandler } from "@/server/intelligence";
export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) { return intelligenceHandler()(request, (await context.params).path); }
