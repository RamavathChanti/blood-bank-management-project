import { connection } from "next/server";
import { publicBoardResponse } from "@/server/public-board";
import { traced } from "@/server/telemetry";

export const runtime = "nodejs";
export const GET = traced("public-board", async () => {
  // Request-time route, persistent Next Data Cache inside the reader. Allows a
  // credential-free build and an honest uncached 503 on an unavailable cold cache.
  await connection();
  return publicBoardResponse();
});
