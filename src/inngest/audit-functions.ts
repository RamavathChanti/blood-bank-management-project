import "server-only";
import { inngest } from "./client";
import { database } from "../server/mongodb";
import { digest, type Row } from "../server/audit";
import { AUDIT_ANCHOR_CRON, AUDIT_VERIFY_CRON, publishGithubAnchor, runAuditVerifier, runDailyAnchor, sendAuditEmail, type AuditReport } from "../server/audit-jobs";
import { ATLAS_WORKFLOW_CONCURRENCY } from "../core/surge";

export const auditVerifier = inngest.createFunction({ id: "audit-verifier-v1", retries: 2, triggers: [{ event: "pulsegrid/audit.verify" }, ...(process.env.AUDIT_JOBS_ENABLED === "1" ? [{ cron: AUDIT_VERIFY_CRON }] : [])], concurrency: [ATLAS_WORKFLOW_CONCURRENCY, { limit: 1, scope: "fn" }] }, async ({ event, step }) => {
  const receipt = await step.run("verify-snapshot-and-record-alert", async () => {
    const report = await runAuditVerifier(await database(), new Date(event.ts).toISOString());
    // Keep private failure lists and large reports out of durable step payloads.
    return { at: report.at, checked: report.checked, valid: report.valid, failed: report.failed.length, orphanEvents: report.orphanEvents };
  });
  await step.run("optional-staff-email", async () => {
    const row = await (await database()).collection<Row>("operations").findOne({ _id: `audit-check-${digest(receipt.at)}` });
    if (!row) throw new Error("AUDIT_REPORT_MISSING");
    return sendAuditEmail(row.result as AuditReport);
  });
  return receipt;
});
export const auditAnchor = inngest.createFunction({ id: "audit-daily-anchor-v1", retries: 2, triggers: [{ event: "pulsegrid/audit.anchor" }, ...(process.env.AUDIT_JOBS_ENABLED === "1" ? [{ cron: AUDIT_ANCHOR_CRON }] : [])], concurrency: [ATLAS_WORKFLOW_CONCURRENCY, { limit: 1, scope: "fn" }] }, async ({ event, step }) => {
  const id = await step.run("commit-daily-merkle-root", async () => (await runDailyAnchor(await database(), new Date(event.ts).toISOString())).id as string);
  return step.run("optional-external-hash-publication", async () => {
    const db = await database(), anchor = await db.collection<Row>("anchors").findOne({ _id: id });
    if (!anchor) throw new Error("ANCHOR_MISSING");
    const external = await publishGithubAnchor(anchor);
    await db.collection("anchors").updateOne({ id }, { $set: { external } });
    return { day: anchor.day, merkleRoot: anchor.merkleRoot, external };
  });
});
