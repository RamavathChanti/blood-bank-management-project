/** PulseGrid canonical JSON v1: sorted UTF-16 keys, ISO dates, finite JSON values.
 * Object undefined is omitted (matching persisted BSON); array undefined is rejected.
 * No Unicode normalization: different strings remain different evidence. */
export function canonical(value: unknown): string {
  if (value instanceof Date) return canonical(value.toISOString());
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonical).join(",")}]`;
  if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).filter(k => (value as Record<string, unknown>)[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new Error("Unsupported canonical value");
}
export type AuditRecord = Record<string, unknown>;
export type AuditEvent = AuditRecord & { id: string; unitId: string; seq: number; actorId: string; at: string | Date; action: string; prevHash: string; hash: string; beforeStateHash: string; stateHash: string; state: AuditRecord };
export type Hash = (text: string) => string | Promise<string>;
export const GENESIS = "0".repeat(64);
export const without = (row: AuditRecord, keys: string[]) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
export const unitState = (row: AuditRecord) => without(row, ["sig", "auditSeq", "auditHead"]);
export const eventPayload = (row: AuditRecord) => without(row, ["hash"]);
export async function sha256(text: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, "0")).join("");
}
export type Verification = { ok: boolean; chain: "VALID" | "BROKEN" | "UNTRACKED"; signature: "VALID" | "MISMATCH" | "UNSIGNED" | "LOCAL_ONLY"; state: "MATCH" | "MISMATCH"; firstBadSeq: number | null; problems: string[] };
/** Input order is evidence: never sort here; missing, repeated and reordered records fail. */
export async function verifyHistory(unit: AuditRecord, events: AuditEvent[], signature: Verification["signature"], hash: Hash = sha256): Promise<Verification> {
  const problems: string[] = []; let firstBadSeq: number | null = null, prevHash = GENESIS, previousState = GENESIS, previousAt = -Infinity;
  const fail = (seq: number, reason: string) => { if (firstBadSeq === null) firstBadSeq = seq; problems.push(reason); };
  for (let i = 0; i < events.length; i++) {
    const e = events[i], seq = i + 1, at = new Date(e.at).getTime();
    try {
      if (e.seq !== seq || e.unitId !== unit.id || e.stateId !== unit.stateId || e.tenantId !== unit.tenantId || e.bankId !== unit.bankId) fail(seq, `EVENT_IDENTITY_OR_SEQUENCE:${seq}`);
      if (!e.actorId || !Number.isFinite(at) || at < previousAt) fail(seq, `EVENT_CHRONOLOGY:${seq}`);
      if (e.prevHash !== prevHash || e.beforeStateHash !== previousState) fail(seq, `PREVIOUS_LINK:${seq}`);
      if (e.hash !== await hash(e.prevHash + canonical(eventPayload(e)))) fail(seq, `EVENT_HASH:${seq}`);
      if (e.stateHash !== await hash(canonical(e.state)) || e.state.id !== unit.id || e.to !== e.state.status || i > 0 && e.from !== events[i - 1].state.status) fail(seq, `EVENT_STATE:${seq}`);
    } catch { fail(seq, `MALFORMED_EVENT:${seq}`); }
    prevHash = e.hash; previousState = e.stateHash; previousAt = at;
  }
  if (events.length && (unit.auditSeq !== events.length || unit.auditHead !== prevHash)) fail(events.length + 1, "HEAD_OR_TAIL_MISMATCH");
  let state: Verification["state"] = "MISMATCH";
  try { if (events.length && previousState === await hash(canonical(unitState(unit)))) state = "MATCH"; } catch { /* malformed state is evidence */ }
  if (state === "MISMATCH") problems.push("CURRENT_STATE_MISMATCH");
  if (signature === "MISMATCH" || signature === "UNSIGNED") problems.push(`SIGNATURE_${signature}`);
  const chain = !events.length ? "UNTRACKED" : firstBadSeq === null ? "VALID" : "BROKEN";
  return { ok: chain === "VALID" && state === "MATCH" && ["VALID", "LOCAL_ONLY"].includes(signature), chain, signature, state, firstBadSeq, problems };
}
/** Domain-separated leaves/internal nodes; duplicate odd nodes; sorted identity-bound leaves. */
export async function merkleRoot(heads: { unitId: string; seq: number; hash: string }[], hash: Hash = sha256) {
  const sorted = [...heads].sort((a, b) => a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0);
  if (new Set(sorted.map(h => h.unitId)).size !== sorted.length) throw new Error("Duplicate Merkle identity");
  let level = await Promise.all(sorted.map(h => hash("leaf:" + canonical(h))));
  if (!level.length) return hash("empty:pulsegrid-audit-v1");
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(await hash("node:" + level[i] + (level[i + 1] ?? level[i])));
    level = next;
  }
  return level[0];
}
