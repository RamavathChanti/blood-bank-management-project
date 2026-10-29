import { parseGroup } from "./domain";
import * as v from "./validation";

export const DEMO_SITES = {
  Pune: [73.86, 18.53], "Mumbai City": [72.83, 18.98],
  "Mumbai Suburban": [72.88, 19.14], Thane: [73.02, 19.25]
} as const;
export const registrationInput = v.object({ group: parseGroup, site: v.oneOf(["Pune", "Mumbai City", "Mumbai Suburban", "Thane"]), consent: (value: unknown) => { if (value !== true) throw new Error("Consent required"); return true; } });
export const responseInput = v.object({ key: v.text, alertId: v.text, reply: v.oneOf(["ACCEPTED", "DECLINED"]) });
export type DonorReply = ReturnType<typeof responseInput>;
export type QueuedReply = DonorReply & { donorId: string; state: "PENDING" | "RECEIVED" | "TOO_LATE"; message?: string };
export type DonorView = {
  donor: { id: string; nickname: string; group: string; eligibleFrom: string; expireAt: string; optedOut: boolean; pushState: string };
  alerts: { id: string; requestId: string; group: string; component: string; quantity: number; status: string; deadlineAt: string; collection: string }[];
  pushPublicKey: string | null;
};
