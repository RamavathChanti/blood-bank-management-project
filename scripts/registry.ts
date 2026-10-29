import { loadEnvConfig } from "@next/env";
import { databaseName, mongoClient } from "../src/server/mongodb";
import { seedRegistry, upgradeSchema, verifyTransaction } from "../src/server/seed";
import { verifyIndexes } from "../src/server/schema";

loadEnvConfig(process.cwd(), true);
async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!["seed", "reset", "verify", "upgrade"].includes(action)) throw new Error("Usage: registry <seed|reset|verify|upgrade> [--confirm=pulsegrid_dev] [--at=ISO] [--preset=development|demo]");
  const options = new Map<string, string>();
  for (const arg of args) {
    const match = /^--(confirm|at|preset)=(.+)$/.exec(arg);
    if (!match || options.has(match[1])) throw new Error("Invalid or duplicate argument");
    options.set(match[1], match[2]);
  }
  const preset = options.get("preset");
  if (preset !== undefined && preset !== "development" && preset !== "demo") throw new Error("Invalid preset");
  const name = databaseName(), client = await mongoClient();
  try {
    const db = client.db(name);
    const report = action === "upgrade" ? await upgradeSchema(db, options.get("confirm")) : action === "verify" ? { database: name, indexes: await verifyIndexes(db), transaction: await verifyTransaction(client, db) } : await seedRegistry(client, db, { confirm: options.get("confirm"), at: options.get("at"), preset, reset: action === "reset" });
    console.log(JSON.stringify(report, null, 2));
  } finally { await client.close(); }
}
main().catch(() => { console.error("Registry operation failed. Check target confirmation, environment, network access, database privileges, schema/indexes and replica-set support. No credential or provider error is printed."); process.exitCode = 1; });
