import "server-only";
import { RegistryError } from "./errors";
import { span } from "./telemetry";

export type DemoFlags = { dbDown: boolean; dbSlowMs: number; realtimeDown: boolean; expiresAt: string };
const off = (): DemoFlags => ({ dbDown: false, dbSlowMs: 0, realtimeDown: false, expiresAt: new Date(0).toISOString() });
export function parseFlags(input: unknown): DemoFlags {
  const v = input as DemoFlags;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["dbDown", "dbSlowMs", "realtimeDown", "expiresAt"].includes(k)) || typeof v.dbDown !== "boolean" || typeof v.realtimeDown !== "boolean" || !Number.isInteger(v.dbSlowMs) || v.dbSlowMs < 0 || v.dbSlowMs > 3000 || typeof v.expiresAt !== "string" || !Number.isFinite(Date.parse(v.expiresAt))) throw new RegistryError(400, "INVALID_DEMO_FLAGS");
  return { dbDown: v.dbDown, dbSlowMs: v.dbSlowMs, realtimeDown: v.realtimeDown, expiresAt: v.expiresAt };
}
function connection() {
  try {
    const url = new URL(process.env.GLOBAL_CONFIG || process.env.EDGE_CONFIG || "");
    if (url.protocol !== "https:" || !["edge-config.vercel.com", "global-config.vercel.com"].includes(url.hostname) || url.username || url.password || url.port || !/^\/ecfg_[a-zA-Z0-9]+$/.test(url.pathname) || !url.searchParams.get("token")) throw new Error();
    return url;
  } catch { throw new RegistryError(503, "DEMO_CONFIG_NOT_CONFIGURED"); }
}
export function controlsEnabled() { return process.env.DEMO_CONTROLS_ENABLED === "1"; }
export async function readDemoFlags(fetcher = fetch): Promise<DemoFlags> {
  if (!controlsEnabled()) return off();
  return span("config", "read-demo-flags", async () => {
    try {
      const url = connection(); url.pathname += "/item/pulsegridChaos";
      const response = await fetcher(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error();
      const flags = parseFlags(await response.json());
      if (Date.parse(flags.expiresAt) > Date.now() + 900_000) throw new Error();
      return Date.parse(flags.expiresAt) <= Date.now() ? off() : flags;
    } catch { throw new RegistryError(503, "DEMO_CONFIG_UNAVAILABLE"); }
  });
}
export async function writeDemoFlags(input: unknown, fetcher = fetch) {
  if (!controlsEnabled()) throw new RegistryError(403, "DEMO_CONTROLS_DISABLED");
  const flags = parseFlags(input), until = Date.parse(flags.expiresAt);
  if (until <= Date.now() || until > Date.now() + 900_000) throw new RegistryError(400, "DEMO_EXPIRY_OUT_OF_RANGE");
  const source = connection(), token = process.env.DEMO_CONFIG_WRITE_TOKEN;
  if (!token) throw new RegistryError(503, "DEMO_WRITE_NOT_CONFIGURED");
  const url = new URL(`https://api.vercel.com/v1/global-config${source.pathname}/items`);
  if (process.env.DEMO_CONFIG_TEAM_ID) url.searchParams.set("teamId", process.env.DEMO_CONFIG_TEAM_ID);
  try {
    const response = await fetcher(url, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ items: [{ operation: "update", key: "pulsegridChaos", value: flags }] }), redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    // A write receipt is not proof that globally replicated reads have converged.
    return { saved: true, propagationPending: true };
  } catch { throw new RegistryError(503, "DEMO_WRITE_UNCONFIRMED"); }
}
export async function databaseFault(read = readDemoFlags) {
  const flags = await read();
  if (flags.dbDown) throw new RegistryError(503, "DEMO_DATABASE_DOWN");
  if (flags.dbSlowMs) await new Promise(resolve => setTimeout(resolve, flags.dbSlowMs));
}
