import "server-only";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { MongoError, type Db } from "mongodb";
import { DEMO_SITES, registrationInput, responseInput } from "../core/donor-app";
import { database } from "./mongodb";
import { RegistryError, validate } from "./errors";
import { readJsonInput } from "./registry-api";
import { WorkflowStore, workflowDigest, type WorkflowRow } from "./workflow-store";
import { STATE_ID } from "./registry-constants";
import { donorModel, encryptSubscription, pushPublicKey, subscriptionInput } from "./donor-push";
import { donorEligibility } from "../core/donor-eligibility";
import { inngest } from "../inngest/client";
import { changed } from "../inngest/events";
import { traced } from "./telemetry";

const cookieName = "pulsegrid-audience";
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const headers = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
type Dependencies = { database: () => Promise<Db>; now: () => Date; wake?: (requestId: string, key: string) => Promise<unknown> };
export function donorHandler(deps: Dependencies = { database, now: () => new Date(), wake: (requestId, key) => inngest.send(changed.create({ requestId }, { id: `${key}-wake` })) }) {
  return traced("donor", async (request: Request, path: string[]) => {
    const reference = randomUUID();
    try {
      const route = path.join("/"), url = new URL(request.url);
      if (url.search || path.length !== 1 || !["register", "me", "reply", "subscription", "opt-out", "delete"].includes(route)) throw new RegistryError(404, "NOT_FOUND");
      if (request.method !== (route === "me" ? "GET" : "POST")) throw new RegistryError(405, "METHOD_NOT_ALLOWED");
      const body = request.method === "POST" ? await readJsonInput(request) : undefined;
      const db = await deps.database(), now = deps.now();
      const c = (name: string) => db.collection<WorkflowRow>(name);
      const token = request.headers.get("cookie")?.split(";").map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? "";
      const own = /^[A-Za-z0-9_-]{43}$/.test(token) ? await c("donors").findOne({ sessionHash: hash(token), audience: true, stateId: STATE_ID, expireAt: { $gt: now } }) : null;
      const cookie = (value: string, maxAge: number) => `${cookieName}=${value}; Path=/api/donor; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${url.protocol === "https:" ? "; Secure" : ""}`;
      const ok = (result: unknown, extra = {}) => Response.json(result, { headers: { ...headers, ...extra } });
      if (route === "register") {
        const input = validate(registrationInput, body);
        if (own) return ok({ donorId: own.id });
        const sessionToken = randomBytes(32).toString("base64url"), id = `audience-${randomUUID()}`;
        const budgetId = `audience-budget-${now.toISOString().slice(0, 13).replace(/[^0-9]/g, "")}`;
        await new WorkflowStore(db, now).transaction(async session => {
          await c("operations").updateOne({ _id: budgetId }, { $setOnInsert: { id: budgetId, stateId: STATE_ID, tenantId: "audience", fingerprint: budgetId, result: {}, count: 0, createdAt: now, expireAt: new Date(now.getTime() + 86400_000) } }, { upsert: true, session });
          const budget = await c("operations").updateOne({ _id: budgetId, count: { $lt: 200 } }, { $inc: { count: 1 } }, { session });
          if (!budget.modifiedCount) throw new RegistryError(429, "DEMO_JOIN_LIMIT_REACHED");
          await c("donors").insertOne({ _id: id, id, stateId: STATE_ID, tenantId: `tenant-${id}`, nickname: `${["Amber", "Coral", "Indigo", "Silver"][randomInt(4)]}-${randomBytes(3).toString("hex")}`, group: input.group, location: { type: "Point", coordinates: [...DEMO_SITES[input.site]] }, demoSite: input.site, birthDate: "2000-01-01", weightKg: 65, haemoglobin: 14, donationVolumeMl: 350, eligibleFrom: now, deferrals: [], audience: true, expireAt: new Date(now.getTime() + 86400_000), sessionHash: hash(sessionToken), optedOut: false, consentAt: now }, { session });
        });
        return ok({ donorId: id }, { "Set-Cookie": cookie(sessionToken, 86400) });
      }
      if (!own) throw new RegistryError(401, "DONOR_SESSION_EXPIRED");
      if (route === "me") {
        const alerts = await c("alerts").find({ donorId: own.id, tenantId: own.tenantId, stateId: STATE_ID }).sort({ createdAt: -1 }).limit(20).toArray();
        const views = [];
        for (const alert of alerts) {
          const req = await c("requests").findOne({ _id: alert.requestId, stateId: STATE_ID });
          if (!req) continue;
          const bank = await c("banks").findOne({ _id: alert.collectionBankId, stateId: STATE_ID });
          const closed = !["OPEN", "PARTIAL"].includes(req.status) || req.allocatedQuantity >= req.quantity || req.expectedTransfusionAt <= now || alert.deadlineAt <= now || own.optedOut;
          views.push({ id: alert.id, requestId: req.id, group: req.group, component: req.component, quantity: req.quantity, status: alert.status === "PENDING" && closed ? "TOO_LATE" : alert.status, deadlineAt: alert.deadlineAt.toISOString(), collection: bank?.name ?? "Demo collection bank" });
        }
        return ok({ donor: { id: own.id, nickname: own.nickname, group: own.group, eligibleFrom: donorEligibility(donorModel(own), now.toISOString()).eligibleFrom, expireAt: own.expireAt.toISOString(), optedOut: Boolean(own.optedOut), pushState: own.pushState ?? "OFF" }, alerts: views, pushPublicKey: pushPublicKey() });
      }
      if (route === "reply") {
        const input = validate(responseInput, body);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.key) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.alertId)) throw new RegistryError(400, "INVALID_INPUT");
        const opId = `donor-reply-${workflowDigest([own.id, input.key])}`, fingerprint = workflowDigest(input);
        const result = await new WorkflowStore(db, now).transaction(async session => {
          const prior = await c("operations").findOne({ _id: opId }, { session });
          if (prior) { if (prior.fingerprint !== fingerprint) throw new RegistryError(409, "IDEMPOTENCY_KEY_REUSED"); return prior.result; }
          const donor = await c("donors").findOne({ _id: own.id, sessionHash: hash(token), expireAt: { $gt: now } }, { session });
          if (!donor) throw new RegistryError(401, "DONOR_SESSION_EXPIRED");
          const alert = await c("alerts").findOne({ _id: input.alertId, donorId: own.id, tenantId: own.tenantId, stateId: STATE_ID }, { session });
          if (!alert) throw new RegistryError(403, "WAVE_MEMBERSHIP_REQUIRED");
          const req = await c("requests").findOne({ _id: alert.requestId, stateId: STATE_ID }, { session });
          const active = req && ["OPEN", "PARTIAL"].includes(req.status) && req.allocatedQuantity < req.quantity && req.expectedTransfusionAt > now && req.workflow?.waves?.some((w: { index: number }) => w.index === alert.wave);
          let state = "TOO_LATE";
          if (!donor.optedOut && donorEligibility(donorModel(donor), now.toISOString()).eligible && active && alert.deadlineAt > now && alert.status === "PENDING") {
            await c("donors").updateOne({ _id: own.id }, { $inc: { responseRevision: 1 } }, { session });
            // Contends with allocation/cancellation so closure wins on transaction retry.
            await c("requests").updateOne({ _id: req!._id }, { $inc: { donorResponseRevision: 1 } }, { session });
            await c("alerts").updateOne({ _id: alert.id, status: "PENDING" }, { $set: { status: input.reply, repliedAt: now } }, { session });
            state = "RECEIVED";
          } else if (alert.status === input.reply) state = "RECEIVED";
          const receipt = { state, reply: input.reply, requestId: alert.requestId };
          await c("operations").insertOne({ _id: opId, id: opId, stateId: STATE_ID, tenantId: own.tenantId, fingerprint, result: receipt, createdAt: now, expireAt: own.expireAt }, { session });
          return receipt;
        });
        // The receipt is already durable. A lost wake is recovered by the workflow's timed recheck.
        if (result.state === "RECEIVED") await deps.wake?.(result.requestId, opId).catch(() => undefined);
        return ok(result);
      }
      if (route === "subscription") {
        if (own.optedOut) throw new RegistryError(409, "DONOR_OPTED_OUT");
        if (!pushPublicKey()) throw new RegistryError(503, "PUSH_NOT_CONFIGURED");
        const subscription = subscriptionInput(body);
        await c("donors").updateOne({ _id: own.id, expireAt: { $gt: now }, optedOut: { $ne: true } }, { $set: { pushSubscription: encryptSubscription(subscription, own.id), pushState: "ON" } });
        return ok({ state: "SUBSCRIBED" });
      }
      if (route === "opt-out") {
        await c("donors").updateOne({ _id: own.id }, { $set: { optedOut: true, pushState: "OFF" }, $unset: { pushSubscription: "" } });
        return ok({ state: "OPTED_OUT" });
      }
      await new WorkflowStore(db, now).transaction(async session => {
        await c("donors").deleteOne({ _id: own.id }, { session });
        await c("alerts").deleteMany({ donorId: own.id }, { session });
        await c("operations").deleteMany({ tenantId: own.tenantId }, { session });
      });
      return ok({ state: "DELETED" }, { "Set-Cookie": cookie("", 0) });
    } catch (error) {
      const mapped = error instanceof RegistryError ? error : new RegistryError(503, error instanceof MongoError ? "DATABASE_UNAVAILABLE" : "DONOR_SERVICE_UNAVAILABLE");
      return Response.json({ error: mapped.code, reference }, { status: mapped.status, headers });
    }
  });
}
