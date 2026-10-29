import "server-only";
import type { Db } from "mongodb";
import { unstable_cache } from "next/cache";
import { PRODUCTS, SCREENS, componentFor } from "../core/domain";
import { DEFAULT_SHELF_LIFE } from "../core/shelf-life";
import { publicBoard, PUBLIC_DISTRICTS } from "../core/public-board";
import { database, databaseName } from "./mongodb";
import { STATE_ID } from "./registry-constants";
import { span } from "./telemetry";

export async function aggregatePublicBoard(db: Db, now = new Date()) {
  // Read actual units, not potentially lagging stock counters. Join institution
  // scope before aggregating; no record IDs, names, donor or request data leave it.
  const counts = await db.collection("units").aggregate<{ district: string; group: string; component: string; count: number }>([
    { $match: { stateId: STATE_ID, status: "AVAILABLE", storage: "VERIFIED", collectedAt: { $type: "date", $lte: now }, expiresAt: { $type: "date", $gt: now }, reservation: { $exists: false }, ...Object.fromEntries(SCREENS.map(screen => [`screening.${screen}`, "NON_REACTIVE"])) } },
    { $match: { $or: PRODUCTS.map(product => ({ product, component: componentFor(product), $expr: { $lte: ["$expiresAt", { $dateAdd: { startDate: "$collectedAt", unit: product === "FFP_FROZEN" ? "year" : "day", amount: product === "FFP_FROZEN" ? DEFAULT_SHELF_LIFE.FFP_FROZEN.calendarYears : DEFAULT_SHELF_LIFE[product].days } }] } })) } },
    { $lookup: { from: "banks", let: { bank: "$bankId", tenant: "$tenantId" }, pipeline: [
      { $match: { stateId: STATE_ID, district: { $in: [...PUBLIC_DISTRICTS] }, $expr: { $and: [{ $eq: ["$_id", "$$bank"] }, { $eq: ["$tenantId", "$$tenant"] }] } } },
      { $project: { _id: 0, district: 1 } }
    ], as: "bank" } },
    { $unwind: "$bank" },
    { $group: { _id: { district: "$bank.district", group: "$group", component: "$component" }, count: { $sum: 1 } } },
    { $project: { _id: 0, district: "$_id.district", group: "$_id.group", component: "$_id.component", count: 1 } }
  ], { maxTimeMS: 5000 }).toArray();
  return publicBoard(now, counts);
}
// Keys include the environment's database name. Throw on failure: Next keeps the
// last successful entry during background revalidation; never cache empty stock
// as a substitute for an unavailable database. No cookies/auth inside this scope.
export function getPublicBoard() {
  return unstable_cache(async () => span("atlas", "public-aggregate", async () => aggregatePublicBoard(await database())), ["public-board-v1", STATE_ID, databaseName()], { revalidate: 30, tags: ["public-board"] })();
}

export async function publicBoardResponse(read = getPublicBoard): Promise<Response> {
  try {
    return Response.json(await read(), { headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      // Short outer cache avoids stacking two 30-second freshness windows.
      "Vercel-CDN-Cache-Control": "public, s-maxage=1, stale-while-revalidate=29",
      "X-Content-Type-Options": "nosniff"
    } });
  } catch {
    return Response.json({ error: "PUBLIC_BOARD_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store", "Retry-After": "30" } });
  }
}
