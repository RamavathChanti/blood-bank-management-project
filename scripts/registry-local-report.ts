import { randomBytes } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import { MongoClient } from "mongodb";
import { resolve } from "node:path";
import { seedRegistry } from "../src/server/seed";

async function main() {
  // This script creates only disposable local test databases. Never persists a key.
  process.env.AUDIT_HMAC_SECRET = randomBytes(32).toString("hex");
  const repl = await MongoMemoryReplSet.create({ binary: { version: "8.0.17", downloadDir: resolve(".tools/mongodb") }, replSet: { count: 1, storageEngine: "wiredTiger" } });
  const client = await new MongoClient(repl.getUri(), { maxPoolSize: 5 }).connect();
  try {
    const results = [];
    for (const preset of ["development", "demo"] as const) {
      const db = client.db(`pulsegrid_test_${preset}`);
      results.push(await seedRegistry(client, db, { confirm: db.databaseName, at: "2026-10-28T12:00:00.000Z", preset }));
    }
    console.log(JSON.stringify({ environment: "temporary local MongoDB replica set; not Atlas", node: process.version, mongodb: "8.0.17", results }, null, 2));
  } finally { await client.close(); await repl.stop(); }
}
main().catch(() => { console.error("Local registry report failed. Check the MongoDB binary download and replica-set startup."); process.exitCode = 1; });
