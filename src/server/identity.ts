import "server-only";
import { auth, currentUser } from "@clerk/nextjs/server";
import * as v from "../core/validation";
import { deny, RegistryError } from "./errors";

import { STATE_ID } from "./registry-constants";
const id = (value: unknown) => {
  const result = v.text(value);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(result)) throw new Error("Invalid ID");
  return result;
};
const common = { tenantId: id, stateId: v.oneOf([STATE_ID]) };
const admin = v.object({ role: v.oneOf(["STATE_ADMIN"]), stateId: common.stateId });
const bank = v.object({ ...common, role: v.oneOf(["BANK"]), bankId: id });
const hospital = v.object({ ...common, role: v.oneOf(["HOSPITAL"]), hospitalId: id });
const donor = v.object({ ...common, role: v.oneOf(["DONOR"]), donorId: id });
export function principalFromMetadata(userId: string, input: unknown) {
  try {
    const role = (input as { role?: unknown } | null)?.role;
    const membership = role === "STATE_ADMIN" ? admin(input) : role === "BANK" ? bank(input) : role === "HOSPITAL" ? hospital(input) : donor(input);
    return { userId, ...membership };
  } catch { return deny("MEMBERSHIP_REQUIRED"); }
}
export type Principal = ReturnType<typeof principalFromMetadata>;
export function clerkConfigured() { return Boolean(process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY); }
export async function identity(): Promise<Principal> {
  if (!clerkConfigured()) throw new RegistryError(503, "AUTH_NOT_CONFIGURED");
  const session = await auth({ acceptsToken: "session_token" });
  if (!session.userId) throw new RegistryError(401, "UNAUTHENTICATED");
  // Backend lookup avoids stale authorization claims after membership revocation.
  // Never use unsafeMetadata, request headers, client props, or arbitrary org IDs.
  const user = await currentUser();
  if (!user || user.id !== session.userId) throw new RegistryError(401, "UNAUTHENTICATED");
  return principalFromMetadata(user.id, user.publicMetadata.registry);
}
