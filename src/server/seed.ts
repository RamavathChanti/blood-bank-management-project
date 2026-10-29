import "server-only";
import { createHash } from "node:crypto";
import { BSON, type Db, type Document, type MongoClient } from "mongodb";
import { generateState } from "../core/state-generator";
import { DEFAULT_SCENARIO, parseScenarioConfig } from "../core/simulation-config";
import { COMPONENTS, GROUPS } from "../core/domain";
import { COLLECTIONS, ensureSchema, verifyIndexes, type CollectionName } from "./schema";
import { baseline, auditSnapshot, signUnit } from "./audit";
import { STATE_ID } from "./registry-constants";

const point = (p: { latitude: number; longitude: number }) => ({ type: "Point", coordinates: [p.longitude, p.latitude] });
const doc = (input: Document, tenantId: string): Document & { _id: string } => ({ ...input, _id: input.id, stateId: STATE_ID, tenantId });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function seedDocuments(at: string, preset: "development" | "demo" = "development") {
  const config = parseScenarioConfig({ ...DEFAULT_SCENARIO, startedAt: at, preset, seed: "monsoon", scenario: "monsoon" });
  const generated = generateState(config);
  const data: Record<CollectionName, (Document & { _id: string })[]> = { banks: [], hospitals: [], units: [], unitEvents: [], requests: [], allocations: [], donors: [], stock: [], alerts: [], operations: [], workflowSignals: [], anchors: [] };
  const bankTenant = (bankId: string) => `tenant-${bankId}`;
  const hospitalTenant = (hospitalId: string) => `tenant-${hospitalId}`;
  data.banks = generated.banks.map(b => doc({ ...b, location: point(b.location) }, bankTenant(b.id)));
  data.hospitals = generated.hospitals.map(h => doc({ ...h, location: point(h.location) }, hospitalTenant(h.id)));
  data.donors = generated.donors.map(d => doc({ ...d, location: point(d.location), eligibleFrom: new Date(d.eligibleFrom), lastDonationAt: d.lastDonationAt ? new Date(d.lastDonationAt) : undefined, audience: false }, `tenant-${d.id}`));
  // Expiring audience fixture is synthetic and never uses a phone or health input.
  const first = data.donors[0];
  data.donors.push({ ...first, _id: "audience-donor-1", id: "audience-donor-1", tenantId: "tenant-audience-donor-1", nickname: "Audience teaching donor", audience: true, expireAt: new Date(Date.parse(at) + 86_400_000) });
  data.units = generated.units.map(u => doc({ ...u, collectedAt: new Date(u.collectedAt), expiresAt: new Date(u.expiresAt) }, bankTenant(u.bankId)));
  for (const b of generated.banks) for (const group of GROUPS) for (const component of COMPONENTS) {
    data.stock.push(doc({ id: `${b.id}-${group.replace("+", "pos").replace("-", "neg")}-${component}`, bankId: b.id, group, component, available: generated.units.filter(u => u.bankId === b.id && u.group === group && u.component === component && u.status === "AVAILABLE" && Date.parse(u.expiresAt) > Date.parse(at)).length }, bankTenant(b.id)));
  }
  data.requests = generated.hospitals.map(h => doc({ id: `seed-request-${h.id}`, hospitalId: h.id, group: "A+", component: "PRBC", quantity: 1, allocatedQuantity: 0, transfusedQuantity: 0, urgency: "ROUTINE", status: "OPEN", createdAt: new Date(at), expectedTransfusionAt: new Date(Date.parse(at) + 86_400_000) }, hospitalTenant(h.id)));
  const bsonBytes = Object.values(data).flat().reduce((sum, row) => sum + BSON.calculateObjectSize(row), 0);
  // Retry receipts have no seed fixtures. Keep the Stage 5 fixture hash stable so
  // adding this empty operational collection never forces a destructive reset.
  return { data, config, bsonBytes, hash: digest(Object.fromEntries(Object.entries(data).filter(([name]) => !["operations", "workflowSignals", "anchors"].includes(name)))) };
}

const marker = "pulsegrid-stage5-v1";
export function requireDemoTarget(name: string, confirmation: string | undefined) {
  if (!/^pulsegrid_(dev|demo|test)(_[a-z0-9]+)*$/.test(name) || confirmation !== name || process.env.VERCEL_ENV === "production") throw new Error("Use a dedicated pulsegrid_dev/demo/test database and --confirm=<exact database>; production execution is disabled.");
}
export async function upgradeSchema(db: Db, confirmation?: string) {
  requireDemoTarget(db.databaseName, confirmation);
  const existing = await db.collection<Document & { _id: string }>("_registryMeta").findOne({ _id: "seed" });
  if (existing?.kind !== marker) throw new Error("Schema upgrades require an existing PulseGrid seed marker.");
  await ensureSchema(db);
  return { database: db.databaseName, indexes: await verifyIndexes(db), dataPreserved: true };
}
async function claimDatabase(db: Db) {
  const meta = db.collection<Document & { _id: string }>("_registryMeta");
  const existing = await meta.findOne({ _id: "seed" });
  if (existing && existing.kind !== marker) throw new Error("Database is owned by a different application.");
  if (!existing) {
    for (const collection of await db.listCollections({}, { nameOnly: true }).toArray()) {
      if (await db.collection(collection.name).findOne({})) throw new Error("Refusing to claim a nonempty database without the PulseGrid seed marker.");
    }
    await meta.insertOne({ _id: "seed", kind: marker });
  }
  return existing;
}
export async function verifyTransaction(client: MongoClient, db: Db) {
  const hello = await db.command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid") throw new Error("A replica set or sharded deployment is required.");
  const session = client.startSession();
  try {
    session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    await db.collection("_registryMeta").insertOne({ kind: "transaction-probe" }, { session });
    await session.abortTransaction(); // Verify a real transactional write without retaining it.
    return { supported: true, probe: "insert-aborted" };
  } finally { await session.endSession(); }
}
export async function seedRegistry(client: MongoClient, db: Db, options: { confirm?: string; at?: string; preset?: "development" | "demo"; reset?: boolean }) {
  requireDemoTarget(db.databaseName, options.confirm);
  signUnit({}); // Validate the server key before even claiming a database.
  const existing = await claimDatabase(db);
  const at = options.at ?? existing?.startedAt as string | undefined ?? new Date().toISOString();
  const preset = options.preset ?? existing?.preset as "development" | "demo" | undefined ?? "development";
  const dataset = seedDocuments(at, preset);
  const sealedSeeds = new Map(dataset.data.units.map(row => [row.id, baseline(row, new Date(at))]));
  const seedBsonBytes = dataset.bsonBytes + dataset.data.units.reduce((bytes, row) => {
    const sealed = sealedSeeds.get(row.id)!;
    return bytes + BSON.calculateObjectSize(sealed.unit) + BSON.calculateObjectSize(sealed.event) - BSON.calculateObjectSize(row);
  }, 0);
  if (seedBsonBytes * 4 > 64 * 1024 * 1024) throw new Error("Seed exceeds the 64 MiB planning budget.");
  if (!options.reset && existing?.hash && existing.hash !== dataset.hash) throw new Error("Dataset changed; use explicit reset with the exact target confirmation.");
  await ensureSchema(db);
  const transaction = await verifyTransaction(client, db);
  if (options.reset) for (const name of COLLECTIONS) await db.collection(name).deleteMany({});
  const counts: Record<string, number> = {};
  for (const name of COLLECTIONS) {
    const records = dataset.data[name];
    for (let start = 0; start < records.length; start += 250) {
      if (name === "units") {
        await auditSnapshot(db, async session => {
          for (const record of records.slice(start, start + 250)) {
            if (await db.collection<Document & { _id: string }>("units").findOne({ _id: record._id }, { session })) continue;
            const sealed = sealedSeeds.get(record.id)!;
            await db.collection<Document & { _id: string }>("units").insertOne(sealed.unit, { session });
            await db.collection<Document & { _id: string }>("unitEvents").insertOne(sealed.event, { session });
          }
        });
        continue;
      }
      await db.collection<Document & { _id: string }>(name).bulkWrite(records.slice(start, start + 250).map(record => ({ updateOne: { filter: { _id: record._id }, update: { $setOnInsert: record }, upsert: true } })), { ordered: true });
    }
    counts[name] = await db.collection(name).countDocuments();
  }
  await db.collection<Document & { _id: string }>("_registryMeta").updateOne({ _id: "seed" }, { $set: { kind: marker, startedAt: at, preset, hash: dataset.hash } });
  const stats = await db.stats();
  return { database: db.databaseName, at, preset, counts, seedHash: dataset.hash, seedBsonBytes, unsignedFixtureBsonBytes: dataset.bsonBytes, storage: { dataBytes: stats.dataSize, indexBytes: stats.indexSize, storageBytes: stats.storageSize }, indexes: await verifyIndexes(db), transaction };
}
