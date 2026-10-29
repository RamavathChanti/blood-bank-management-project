import "server-only";
import { randomUUID } from "node:crypto";
import { MongoError, MongoServerError } from "mongodb";
import type { Db } from "mongodb";
import { identity, type Principal } from "./identity";
import { database } from "./mongodb";
import { RegistryError } from "./errors";
import { Registry } from "./registry";
import { Operations } from "./operations";
import { span, traced } from "./telemetry";

export type ApiDependencies = { identity: () => Promise<Principal>; database: () => Promise<Db>; log: (entry: Record<string, unknown>) => void; now?: () => Date };
const defaults: ApiDependencies = { identity, database, log: entry => console.warn(JSON.stringify(entry)) };
const headers = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie, Authorization", "X-Content-Type-Options": "nosniff" };
export async function readJsonInput(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") throw new RegistryError(403, "ORIGIN_DENIED");
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new RegistryError(415, "JSON_REQUIRED");
  if (Number(request.headers.get("content-length")) > 8192) throw new RegistryError(413, "BODY_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) throw new RegistryError(400, "INVALID_INPUT");
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); throw new RegistryError(413, "BODY_TOO_LARGE"); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new RegistryError(400, "INVALID_INPUT"); }
}
export function registryHandler(deps = defaults) {
  return traced("registry", async (request: Request, path: string[]) => {
    const requestId = randomUUID(); let actor: Principal | undefined;
    try {
      actor = await deps.identity();
      const url = new URL(request.url);
      if ([...url.searchParams.keys()].some(key => key !== "after") || url.searchParams.getAll("after").length > 1) throw new RegistryError(400, "INVALID_INPUT");
      if (!["GET", "PATCH", "POST"].includes(request.method)) throw new RegistryError(405, "METHOD_NOT_ALLOWED");
      const body = request.method !== "GET" ? await readJsonInput(request) : undefined;
      if (request.method !== "GET" && url.search) throw new RegistryError(400, "INVALID_INPUT");
      const db = await deps.database(), now = deps.now?.();
      const principal = actor;
      const registry = new Registry(db, actor, now);
      const result = await span("atlas", "registry-operation", () => request.method === "GET" ? registry.read(path, url.searchParams.get("after") ?? undefined) : request.method === "POST" ? new Operations(db, principal, now).post(path, body) : registry.patch(path, body));
      return Response.json(result, { headers: { ...headers, "X-Request-Id": requestId } });
    } catch (error) {
      const mapped = error instanceof RegistryError ? error : error instanceof MongoServerError && error.code === 11000 ? new RegistryError(409, "CONFLICT") : error instanceof MongoServerError && error.code === 121 ? new RegistryError(400, "INVALID_INPUT") : error instanceof MongoError ? new RegistryError(503, "DATABASE_UNAVAILABLE") : new RegistryError(503, "SERVICE_UNAVAILABLE");
      // Fixed fields only: no URL, query/body, token, provider message or connection string.
      deps.log({ event: mapped.status === 401 || mapped.status === 403 ? "registry.access_denied" : "registry.error", requestId, actorId: actor?.userId ?? null, role: actor?.role ?? null, code: mapped.code, status: mapped.status });
      return Response.json({ error: mapped.code, requestId }, { status: mapped.status, headers: { ...headers, "X-Request-Id": requestId } });
    }
  });
}
