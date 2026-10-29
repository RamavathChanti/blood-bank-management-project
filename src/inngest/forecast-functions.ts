import "server-only";
import { NonRetriableError } from "inngest";
import { inngest } from "./client";
import { FORECAST_CRON, runForecastJob } from "../server/forecast-jobs";
import { database } from "../server/mongodb";
import { RegistryError } from "../server/errors";
import { ATLAS_WORKFLOW_CONCURRENCY } from "../core/surge";

// No cron is registered until the dedicated cloud demo environment opts in.
// Manual events are delivered only through the signed Inngest callback.
export const forecastMaintenance = inngest.createFunction({
  id: "forecast-rebalancing-v1", retries: 2,
  triggers: [{ event: "pulsegrid/forecast.requested" }, ...(process.env.FORECAST_JOBS_ENABLED === "1" ? [{ cron: FORECAST_CRON }] : [])],
  concurrency: [ATLAS_WORKFLOW_CONCURRENCY, { limit: 1, scope: "fn" }]
}, async ({ event, step }) => {
  // Derive the slot from immutable provider event time, never caller-supplied data or retry wall time.
  const scheduledAt = new Date(event.ts).toISOString();
  return step.run("daily-forecast-and-rebalancing-proposal", async () => {
    try {
      const result = await runForecastJob(await database(), scheduledAt);
      // Step state holds a small receipt, not private unit IDs or the full forecast.
      return { day: result.day, inputSha256: result.inputSha256, measured: result.measured, proposals: result.plannedTransfers.length };
    } catch (error) {
      if (error instanceof RegistryError && error.status < 500) throw new NonRetriableError(error.code);
      throw error;
    }
  });
});
