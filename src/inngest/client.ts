import "server-only";
import { Inngest } from "inngest";
import { RegistryError } from "../server/errors";

export const inngest = new Inngest({ id: "pulsegrid-college-demo", isDev: process.env.VERCEL ? false : undefined, checkpointing: { maxRuntime: "40s" } });
export function workflowConfigured() {
  const dev = process.env.INNGEST_DEV === "1" && !process.env.VERCEL;
  return dev || Boolean(process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY && process.env.WORKFLOW_RECEIPT_SECRET);
}
export function requireWorkflow() {
  if (!workflowConfigured() || process.env.VERCEL && process.env.INNGEST_DEV === "1") throw new RegistryError(503, "WORKFLOW_NOT_CONFIGURED");
}
