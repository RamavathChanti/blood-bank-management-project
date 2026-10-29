import "server-only";
import { MongoServerError, type Db } from "mongodb";
import { canonical, merkleRoot } from "../core/audit";
import { auditSnapshot, digest, verifyUnit, type Row } from "./audit";
import { RegistryError } from "./errors";
import { STATE_ID } from "./registry-constants";

export const AUDIT_VERIFY_CRON = "*/15 * * * *";
export const AUDIT_ANCHOR_CRON = "TZ=Asia/Kolkata 15 2 * * *";
export const AUDIT_UNIT_LIMIT = 2000;
export type AuditReport = { kind: "AUDIT_REPORT"; at: string; checked: number; valid: number; failed: { unitId: string; chain: string; signature: string; state: string; firstBadSeq: number | null }[]; orphanEvents: number; ok: boolean };
function instant(at: string) { if (!Number.isFinite(Date.parse(at))) throw new RegistryError(400, "INVALID_SCHEDULE_TIME"); return new Date(at).toISOString(); }
async function inspect(db: Db, at: string, anchor: boolean) {
  return auditSnapshot(db, async session => {
    const units = await db.collection<Row>("units").find({ stateId: STATE_ID }, { session }).sort({ _id: 1 }).limit(AUDIT_UNIT_LIMIT + 1).batchSize(AUDIT_UNIT_LIMIT + 1).toArray();
    if (units.length > AUDIT_UNIT_LIMIT) throw new RegistryError(409, "AUDIT_UNIT_BUDGET_EXCEEDED");
    const failed: AuditReport["failed"] = [], heads: { unitId: string; seq: number; hash: string }[] = [];
    for (const unit of units) {
      const { verification: v } = await verifyUnit(db, unit, session);
      if (!v.ok) failed.push({ unitId: unit.id, chain: v.chain, signature: v.signature, state: v.state, firstBadSeq: v.firstBadSeq });
      heads.push({ unitId: unit.id, seq: unit.auditSeq, hash: unit.auditHead });
    }
    // A deleted unit must not disappear silently from the verifier's denominator.
    const orphans = await db.collection("unitEvents").aggregate([
      { $match: { stateId: STATE_ID } }, { $group: { _id: "$unitId" } },
      { $lookup: { from: "units", localField: "_id", foreignField: "id", as: "unit", pipeline: [{ $match: { stateId: STATE_ID } }, { $project: { _id: 1 } }] } },
      { $match: { unit: { $size: 0 } } }, { $count: "count" }
    ], { session, maxTimeMS: 10000 }).toArray();
    const orphanEvents = orphans[0]?.count ?? 0;
    const report: AuditReport = { kind: "AUDIT_REPORT", at, checked: units.length, valid: units.length - failed.length, failed, orphanEvents, ok: failed.length === 0 && orphanEvents === 0 };
    if (!anchor) {
      const id = `audit-check-${digest(at)}`;
      await db.collection<Row>("operations").updateOne({ _id: id }, { $set: { id, stateId: STATE_ID, tenantId: "state-audit", fingerprint: digest(at), createdAt: new Date(at), expireAt: new Date(Date.parse(at) + 31 * 86400000), result: report } }, { session, upsert: true });
      if (!report.ok) {
        console.error(JSON.stringify({ event: "pulsegrid.alert", kind: "INTEGRITY_FAILURE", checked: report.checked, failed: report.failed.length, orphanEvents: report.orphanEvents, at: report.at }));
        const alertId = `audit-alert-${digest(at)}`;
        await db.collection<Row>("operations").updateOne({ _id: alertId }, { $setOnInsert: { id: alertId, stateId: STATE_ID, tenantId: "state-audit-alert", fingerprint: digest(at), createdAt: new Date(at), result: { ...report, kind: "AUDIT_ALERT" } } }, { session, upsert: true });
      }
      return { report, anchor: null };
    }
    if (!report.ok) throw new RegistryError(409, "AUDIT_ANCHOR_REFUSED");
    const day = new Date(Date.parse(at) + 19800000).toISOString().slice(0, 10), id = `audit-anchor-${STATE_ID}-${day}`;
    const previous = await db.collection<Row>("anchors").findOne({ _id: id, stateId: STATE_ID }, { session });
    if (previous) return { report, anchor: previous };
    const row: Row = { _id: id, id, day, stateId: STATE_ID, tenantId: "state-audit", version: 1, createdAt: new Date(at), count: heads.length, heads, merkleRoot: await merkleRoot(heads, digest) };
    await db.collection<Row>("anchors").insertOne(row, { session });
    return { report, anchor: row };
  });
}
export async function runAuditVerifier(db: Db, at: string) { return (await inspect(db, instant(at), false)).report; }
export async function runDailyAnchor(db: Db, at: string): Promise<Row> {
  const time = instant(at), day = new Date(Date.parse(time) + 19800000).toISOString().slice(0, 10);
  const previous = await db.collection<Row>("anchors").findOne({ stateId: STATE_ID, day });
  if (previous) return previous;
  try { return (await inspect(db, time, true)).anchor!; }
  catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
      const winner = await db.collection<Row>("anchors").findOne({ stateId: STATE_ID, day });
      if (winner) return winner;
    }
    throw error;
  }
}
/** Compare retained commitments to historical events, allowing legitimate later appends. */
export async function verifyAnchor(db: Db, anchor: Row) {
  return auditSnapshot(db, async session => {
    const heads = anchor.heads as { unitId: string; seq: number; hash: string }[];
    if (await merkleRoot(heads, digest) !== anchor.merkleRoot || heads.length !== anchor.count) return { ok: false, reason: "ANCHOR_ROOT_MISMATCH" };
    for (const head of heads) {
      const event = await db.collection<Row>("unitEvents").findOne({ stateId: anchor.stateId, unitId: head.unitId, seq: head.seq }, { session });
      if (!event || event.hash !== head.hash) return { ok: false, reason: "ANCHORED_HEAD_MISMATCH", unitId: head.unitId };
    }
    return { ok: true, reason: "ANCHORED_HEADS_MATCH" };
  });
}
/** Public payload contains only the commitment and non-identifying count/date/version. */
export function publicAnchor(anchor: Row) { return { version: 1, day: anchor.day as string, merkleRoot: anchor.merkleRoot as string, count: anchor.count as number }; }
export async function publishGithubAnchor(anchor: Row, fetcher: typeof fetch = fetch) {
  const repo = process.env.GITHUB_ANCHOR_REPOSITORY, branch = process.env.GITHUB_ANCHOR_BRANCH, token = process.env.GITHUB_ANCHOR_TOKEN;
  if (process.env.AUDIT_GITHUB_ENABLED !== "1") return { status: "DISABLED" };
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !branch || !/^[\w./-]+$/.test(branch) || !token) throw new RegistryError(503, "ANCHOR_PUBLICATION_UNCONFIGURED");
  const url = `https://api.github.com/repos/${repo}/contents/audit-anchors/${anchor.day}.json`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const content = canonical(publicAnchor(anchor)) + "\n";
  const existing = await fetcher(`${url}?ref=${encodeURIComponent(branch)}`, { headers, signal: AbortSignal.timeout(10000), redirect: "error" });
  if (existing.ok) {
    const data = await existing.json();
    if (Buffer.from(data.content, "base64").toString("utf8") !== content) throw new RegistryError(409, "EXTERNAL_ANCHOR_CONFLICT");
    return { status: "PUBLISHED", url: data.html_url as string };
  }
  if (existing.status !== 404) throw new RegistryError(503, "ANCHOR_PUBLICATION_FAILED");
  const response = await fetcher(url, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ message: `Audit commitment ${anchor.day}`, branch, content: Buffer.from(content).toString("base64") }), signal: AbortSignal.timeout(10000), redirect: "error" });
  if (!response.ok) throw new RegistryError(503, "ANCHOR_PUBLICATION_FAILED");
  const data = await response.json();
  return { status: "PUBLISHED", url: data.content.html_url as string };
}
export async function sendAuditEmail(report: AuditReport, fetcher: typeof fetch = fetch) {
  if (report.ok || process.env.AUDIT_EMAIL_ENABLED !== "1") return { status: "DISABLED_OR_CLEAN" };
  const token = process.env.RESEND_API_KEY, to = process.env.AUDIT_STAFF_EMAIL, from = process.env.AUDIT_EMAIL_FROM;
  if (!token || !to || !from) throw new RegistryError(503, "AUDIT_EMAIL_UNCONFIGURED");
  const response = await fetcher("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": `audit-${digest(report.at)}` }, body: JSON.stringify({ from, to: [to], subject: "PulseGrid synthetic registry integrity alert", text: `${report.failed.length} unit checks and ${report.orphanEvents} orphan histories failed at ${report.at}. Sign in to the state registry to inspect. Teaching model, not clinical software.` }), signal: AbortSignal.timeout(10000), redirect: "error" });
  if (!response.ok) throw new RegistryError(503, "AUDIT_EMAIL_FAILED");
  return { status: "SENT" };
}
