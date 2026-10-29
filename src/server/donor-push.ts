import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import webpush from "web-push";
import type { PushSubscription } from "web-push";
import type { Db } from "mongodb";
import { RegistryError } from "./errors";
import { STATE_ID } from "./registry-constants";
import { parseDonor } from "../core/domain";
import { donorEligibility } from "../core/donor-eligibility";
import { isCompatible } from "../core/compatibility";
import type { WorkflowRow } from "./workflow-store";

function encryptionKey() {
  const raw = process.env.DONOR_PUSH_ENCRYPTION_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(raw)) throw new RegistryError(503, "PUSH_NOT_CONFIGURED");
  return Buffer.from(raw, "hex");
}
export function pushPublicKey() {
  try { encryptionKey(); return process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT && process.env.VAPID_PUBLIC_KEY || null; } catch { return null; }
}
export function subscriptionInput(value: unknown): PushSubscription {
  const input = value as PushSubscription;
  if (!input || Object.keys(input).some(k => !["endpoint", "keys", "expirationTime"].includes(k)) || typeof input.endpoint !== "string" || input.endpoint.length > 2048) throw new RegistryError(400, "INVALID_SUBSCRIPTION");
  let url: URL; try { url = new URL(input.endpoint); } catch { throw new RegistryError(400, "INVALID_SUBSCRIPTION"); }
  const allowed = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"].includes(url.hostname) || /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname);
  if (!allowed || url.protocol !== "https:" || url.port || url.username || url.password || url.hash || !/^[A-Za-z0-9_-]{87}$/.test(input.keys?.p256dh ?? "") || !/^[A-Za-z0-9_-]{22}$/.test(input.keys?.auth ?? "")) throw new RegistryError(400, "INVALID_SUBSCRIPTION");
  return { endpoint: input.endpoint, keys: { p256dh: input.keys.p256dh, auth: input.keys.auth } };
}
export function encryptSubscription(input: PushSubscription, donorId: string) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(donorId));
  const data = Buffer.concat([cipher.update(JSON.stringify(input), "utf8"), cipher.final()]);
  return { v: 1, iv: iv.toString("base64"), data: data.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
export function decryptSubscription(input: ReturnType<typeof encryptSubscription>, donorId: string) {
  if (input.v !== 1) throw new Error("Unknown encryption version");
  const cipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(input.iv, "base64"));
  cipher.setAAD(Buffer.from(donorId)); cipher.setAuthTag(Buffer.from(input.tag, "base64"));
  return subscriptionInput(JSON.parse(Buffer.concat([cipher.update(Buffer.from(input.data, "base64")), cipher.final()]).toString("utf8")));
}
export function donorModel(row: WorkflowRow) {
  return parseDonor(Object.fromEntries(["id", "nickname", "group", "birthDate", "weightKg", "haemoglobin", "donationVolumeMl", "lastDonationAt", "eligibleFrom", "deferrals"].map(k => [k, row[k] instanceof Date ? row[k].toISOString() : row[k]]).concat([["location", { longitude: row.location.coordinates[0], latitude: row.location.coordinates[1] }]])));
}
type Send = (subscription: PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;
/** Separate durable notification job; provider failure cannot block the emergency. */
export async function deliverDonorPush(db: Db, requestId: string, now = new Date(), send: Send = webpush.sendNotification) {
  if (!pushPublicKey()) return;
  const c = (name: string) => db.collection<WorkflowRow>(name);
  const alerts = await c("alerts").find({ requestId, stateId: STATE_ID, status: "PENDING", deadlineAt: { $gt: now }, pushStatus: { $nin: ["SENT", "EXPIRED", "FAILED"] } }).limit(100).toArray();
  let retry = false;
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, alerts.length) }, async () => {
   while (cursor < alerts.length) {
    const alert = alerts[cursor++];
    const donor = await c("donors").findOne({ _id: alert.donorId, stateId: STATE_ID, tenantId: alert.tenantId, optedOut: { $ne: true }, pushSubscription: { $exists: true }, $or: [{ audience: false }, { audience: true, expireAt: { $gt: now } }] });
    const req = await c("requests").findOne({ _id: requestId, stateId: STATE_ID, status: { $in: ["OPEN", "PARTIAL"] }, expectedTransfusionAt: { $gt: now }, $expr: { $lt: ["$allocatedQuantity", "$quantity"] } });
    if (!donor || !req || !req.workflow?.waves?.some((w: { index: number }) => w.index === alert.wave)) continue;
    try { if (!donorEligibility(donorModel(donor), now.toISOString()).eligible || !isCompatible(donor.group, req.group, req.component)) continue; } catch { continue; }
    const recent = await c("alerts").find({ donorId: donor.id, stateId: STATE_ID, createdAt: { $gt: new Date(now.getTime() - 30 * 86400_000) } }).limit(5).toArray();
    const hour = new Date(now.getTime() + 330 * 60_000).getUTCHours();
    if (recent.length > 4 || recent.some(a => a.id !== alert.id && a.createdAt > new Date(now.getTime() - 86400_000)) || req.urgency !== "CRITICAL" && (hour >= 22 || hour < 7)) continue;
    const claim = await c("alerts").updateOne({ _id: alert.id, status: "PENDING", deadlineAt: { $gt: now }, pushStatus: { $nin: ["SENT", "EXPIRED", "FAILED"] }, $or: [{ pushLeaseAt: { $exists: false } }, { pushLeaseAt: { $lt: new Date(now.getTime() - 30_000) } }] }, { $set: { pushLeaseAt: now } });
    if (!claim.modifiedCount) continue;
    try {
      await send(decryptSubscription(donor.pushSubscription, donor.id), JSON.stringify({ title: "PulseGrid synthetic donor alert", body: "A demo request needs a response. Open the app to review.", alertId: alert.id }), { vapidDetails: { subject: process.env.VAPID_SUBJECT!, publicKey: process.env.VAPID_PUBLIC_KEY!, privateKey: process.env.VAPID_PRIVATE_KEY! }, TTL: Math.max(0, Math.floor((alert.deadlineAt.getTime() - now.getTime()) / 1000)), timeout: 10_000, topic: alert.id.slice(-32) });
      await c("alerts").updateOne({ _id: alert.id }, { $set: { pushStatus: "SENT" }, $unset: { pushLeaseAt: "" } });
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await c("donors").updateOne({ _id: donor.id, pushSubscription: donor.pushSubscription }, { $unset: { pushSubscription: "" }, $set: { pushState: "EXPIRED" } });
      const transient = !status || status === 429 || status >= 500;
      retry ||= transient;
      await c("alerts").updateOne({ _id: alert.id }, { $set: { pushStatus: status === 404 || status === 410 ? "EXPIRED" : transient ? "RETRY" : "FAILED" }, $unset: { pushLeaseAt: "" } });
      // Provider details and subscription endpoints must never enter logs or the UI.
    }
   }
  }));
  if (retry) throw new RegistryError(503, "PUSH_DELIVERY_RETRY");
}
