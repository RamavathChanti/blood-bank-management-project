import { randomBytes } from "node:crypto";
process.env.AUDIT_HMAC_SECRET = randomBytes(32).toString("hex");
