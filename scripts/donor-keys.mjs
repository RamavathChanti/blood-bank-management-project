import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import webpush from "web-push";

const subject = process.argv[2];
if (!subject || !/^(mailto:|https:\/\/)/.test(subject) || /[\r\n"']/.test(subject)) {
  console.error("Usage: npm run donor:keys -- <operator mailto:address or https://contact-page>"); process.exit(1);
}
const file = new URL("../.env.local", import.meta.url);
let content = "";
try { content = await readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (/^\s*(VAPID_PUBLIC_KEY|VAPID_PRIVATE_KEY|DONOR_PUSH_ENCRYPTION_KEY)\s*=\s*\S+/m.test(content)) {
  console.error("Existing key material found. Refusing to rotate keys or invalidate subscriptions."); process.exit(1);
}
const keys = webpush.generateVAPIDKeys();
const values = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: subject, DONOR_PUSH_ENCRYPTION_KEY: randomBytes(32).toString("hex") };
for (const [key, value] of Object.entries(values)) {
  const line = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  content = line.test(content) ? content.replace(line, `${key}=${value}`) : `${content.trimEnd()}\n${key}=${value}\n`;
}
await writeFile(file, content, { mode: 0o600 });
console.log("Stage 9 keys saved to ignored .env.local. Restart the app. Copy these server-only values to your deployment environment through its secret settings.");
