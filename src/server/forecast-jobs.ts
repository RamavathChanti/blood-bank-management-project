import "server-only";
import { createHash } from "node:crypto";
import { BSON, MongoServerError, type Db, type Document } from "mongodb";
import { parseBank, parseComponent, parseGroup } from "../core/domain";
import { bloodWeather, DEFAULT_FORECAST, type WeatherRow } from "../core/forecast";
import { DEFAULT_REBALANCE, planRebalancing, type PlannedTransfer } from "../core/rebalancing";
import { DAY_MS } from "../core/shelf-life";
import type { HistoricalIssue } from "../core/state-generator";
import { unitModel } from "./operations";
import { STATE_ID } from "./registry-constants";
import { RegistryError } from "./errors";

type Row = Document & { _id: string };
export const FORECAST_CRON = "TZ=Asia/Kolkata 0 2 * * *";
export const FORECAST_JOB_LIMITS = { banks: 40, units: 20000, issues: 50000, resultBytes: 3 * 1024 * 1024, steps: 1, executionsPerDayWithoutRetries: 2, executionsPer31DaysWithoutRetries: 62 } as const;
export type ForecastJobResult = { kind: "REGISTRY_FORECAST_PROPOSAL"; day: string; cutoff: string; stateId: string; weather: WeatherRow[]; plannedTransfers: PlannedTransfer[]; measured: { banks: number; units: number; issues: number; resultBytes: number }; inputSha256: string; limitations: string };
export function forecastDay(at: string) {
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp)) throw new RegistryError(400, "INVALID_SCHEDULE_TIME");
  const day = new Date(timestamp + 5.5 * 3600000).toISOString().slice(0, 10);
  return { day, cutoff: new Date(`${day}T00:00:00+05:30`).toISOString() };
}
/** One snapshot transaction + a durable daily receipt. This job stores proposals,
 * never changes live unit ownership, stock, allocation, or donor records. */
export async function runForecastJob(db: Db, scheduledAt: string): Promise<ForecastJobResult> {
  const { day, cutoff } = forecastDay(scheduledAt), id = `forecast-v1-${STATE_ID}-${day}`, operations = db.collection<Row>("operations");
  const previous = await operations.findOne({ _id: id, stateId: STATE_ID }, { timeoutMS: 5000 });
  if (previous) return previous.result as ForecastJobResult;
  const session = db.client.startSession(), signal = AbortSignal.timeout(35000);
  try {
    return await session.withTransaction(async () => {
      const previous = await operations.findOne({ _id: id, stateId: STATE_ID }, { session, signal });
      if (previous) return previous.result as ForecastJobResult;
      // One abort deadline bounds the whole attempt, including getMore batches.
      // Avoid driver 7's session-CSOT/getMore interaction; each initial query
      // also has a server-side execution budget.
      const filter = { stateId: STATE_ID }, query = { session, signal, maxTimeMS: 10000 };
      // MongoDB does not support parallel operations inside a transaction.
      const bankRows = await db.collection<Row>("banks").find(filter, query).sort({ _id: 1 }).limit(FORECAST_JOB_LIMITS.banks + 1).toArray();
      const unitRows = await db.collection<Row>("units").find(filter, query).sort({ _id: 1 }).limit(FORECAST_JOB_LIMITS.units + 1).toArray();
      const eventRows = await db.collection<Row>("unitEvents").find({ ...filter, action: "ISSUE", at: { $gte: new Date(Date.parse(cutoff) - 70 * DAY_MS), $lt: new Date(cutoff) } }, query).sort({ at: 1, _id: 1 }).limit(FORECAST_JOB_LIMITS.issues + 1).toArray();
      if (bankRows.length > FORECAST_JOB_LIMITS.banks || unitRows.length > FORECAST_JOB_LIMITS.units || eventRows.length > FORECAST_JOB_LIMITS.issues) throw new RegistryError(409, "FORECAST_INPUT_BUDGET_EXCEEDED");
      const marker = await db.collection<Row>("_registryMeta").findOne({ _id: "seed", kind: "pulsegrid-stage5-v1" }, query);
      const banks = bankRows.map(row => parseBank({ id: row.id, name: row.name, district: row.district, location: { longitude: row.location.coordinates[0], latitude: row.location.coordinates[1] } }));
      const units = unitRows.map(row => unitModel(row)), byId = new Map(units.map(unit => [unit.id, unit]));
      const seen = new Set<string>(), issues: HistoricalIssue[] = [];
      for (const event of eventRows) {
        const unit = byId.get(event.unitId);
        // Multiple ISSUE events for one unit are not silently counted as multiple donations.
        if (!unit || seen.has(unit.id) || !banks.some(b => b.id === event.bankId)) throw new RegistryError(409, "FORECAST_HISTORY_INCONSISTENT");
        seen.add(unit.id);
        issues.push({ id: event.id, bankId: event.bankId, hospitalId: event.hospitalId ?? "synthetic-unattributed", group: parseGroup(unit.group), component: parseComponent(unit.component), quantity: 1, at: new Date(event.at).toISOString() });
      }
      // Seed prehistory was never imported to Atlas. Coverage starts at registry
      // initialization, with later banks conservatively unobserved unless dated.
      const coverage = bankRows.flatMap(row => {
        const number = /^demo-bank-(\d+)$/.exec(row.id)?.[1], seeded = number && Number(number) >= 1 && Number(number) <= (marker?.preset === "demo" ? 20 : 4);
        const from = row.createdAt ?? (seeded ? marker?.startedAt : undefined);
        return from && Number.isFinite(Date.parse(String(from))) ? [{ bankId: row.id as string, from: new Date(from).toISOString(), until: cutoff }] : [];
      });
      // This is a current stock snapshot, NOT an as-of-midnight reconstruction.
      // Forecast bins end at midnight; expiry/travel constraints start at scheduledAt.
      const weather = bloodWeather(banks, units, issues, coverage, scheduledAt, DEFAULT_FORECAST, new Set(), cutoff);
      const plan = planRebalancing(banks, units, weather, scheduledAt, DEFAULT_REBALANCE);
      const result: ForecastJobResult = { kind: "REGISTRY_FORECAST_PROPOSAL", day, cutoff, stateId: STATE_ID, weather, plannedTransfers: plan.transfers, measured: { banks: banks.length, units: units.length, issues: issues.length, resultBytes: 0 }, inputSha256: createHash("sha256").update(JSON.stringify({ banks, units, issues, coverage })).digest("hex"), limitations: "Synthetic registry only. Current transaction stock snapshot; 14-day issue bins end at IST midnight. No imported seed prehistory. Missing history is unknown. Proposals require staff review and fresh transactional dispatch checks; no live transfers or camps are executed." };
      result.measured.resultBytes = BSON.calculateObjectSize(result);
      result.measured.resultBytes = BSON.calculateObjectSize(result);
      if (result.measured.resultBytes > FORECAST_JOB_LIMITS.resultBytes) throw new RegistryError(409, "FORECAST_RESULT_BUDGET_EXCEEDED");
      signal.throwIfAborted();
      await operations.insertOne({ _id: id, id, stateId: STATE_ID, tenantId: "state-forecast-scheduler", fingerprint: result.inputSha256, result, createdAt: new Date(scheduledAt), expireAt: new Date(Date.parse(scheduledAt) + 35 * DAY_MS) }, { session, timeoutMS: 5000 });
      return result;
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 5000 });
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
      const winner = await operations.findOne({ _id: id, stateId: STATE_ID }, { timeoutMS: 5000 });
      if (winner) return winner.result as ForecastJobResult;
    }
    throw error;
  } finally { await session.endSession(); }
}
