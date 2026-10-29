import { beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { canonical, GENESIS, merkleRoot, verifyHistory } from "../../src/core/audit";
import { passportFixture, tamperFixture } from "../../src/core/audit-fixture";

let fixture: Awaited<ReturnType<typeof passportFixture>>;
beforeAll(async () => { fixture = await passportFixture(); });
it("canonicalizes nested order, dates, escaped strings, omitted optionals and negative zero", () => {
  expect(canonical({ z: undefined, b: [new Date("2026-10-29Z"), -0, "\n雪"], a: { y: true, x: null } })).toBe('{"a":{"x":null,"y":true},"b":["2026-10-29T00:00:00.000Z",0,"\\n雪"]}');
  expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }));
});
it.each([NaN, Infinity, 1n, new Map(), [undefined], Array(1)])("rejects ambiguous/non-JSON input %s", value => {
  expect(() => canonical(value)).toThrow();
});
it("verifies an independently recomputed SHA-256 and a complete lifecycle", async () => {
  const e = fixture.events[0], { hash, ...payload } = e;
  expect(hash).toBe(createHash("sha256").update(GENESIS + canonical(payload)).digest("hex"));
  expect(await verifyHistory(fixture.unit, fixture.events, "LOCAL_ONLY")).toMatchObject({ ok: true, firstBadSeq: null });
  expect(fixture.events.map(e => e.action)).toEqual(["COLLECT", "START_TESTING", "UPDATE_SCREENING", "VERIFY_STORAGE", "MAKE_AVAILABLE", "RESERVE", "ISSUE", "HANDOVER", "TRANSFUSE"]);
});
it.each(["event", "missing", "reordered"] as const)("locates %s damage at record three", async mode => {
  const changed = tamperFixture(fixture, mode);
  expect(await verifyHistory(changed.unit, changed.events, "LOCAL_ONLY")).toMatchObject({ ok: false, chain: "BROKEN", firstBadSeq: 3 });
});
it("distinguishes current document damage from event chain damage", async () => {
  const changed = tamperFixture(fixture, "unit");
  expect(await verifyHistory(changed.unit, changed.events, "MISMATCH")).toMatchObject({ ok: false, chain: "VALID", signature: "MISMATCH", state: "MISMATCH", firstBadSeq: null });
});
it("detects deleted tail, duplicate, missing entire history and wrong head", async () => {
  expect(await verifyHistory(fixture.unit, fixture.events.slice(0, -1), "VALID")).toMatchObject({ chain: "BROKEN", firstBadSeq: 9 });
  expect(await verifyHistory(fixture.unit, [...fixture.events.slice(0, 2), fixture.events[1], ...fixture.events.slice(2)], "VALID")).toMatchObject({ firstBadSeq: 3 });
  expect(await verifyHistory(fixture.unit, [], "UNSIGNED")).toMatchObject({ ok: false, chain: "UNTRACKED" });
  expect(await verifyHistory({ ...fixture.unit, auditHead: GENESIS }, fixture.events, "MISMATCH")).toMatchObject({ ok: false, chain: "BROKEN" });
});
it("Merkle trees bind identities, order deterministically, duplicate odd leaves, and define empty roots", async () => {
  const h = (s: string) => createHash("sha256").update(s).digest("hex"), heads = ["c", "a", "b"].map(unitId => ({ unitId, seq: 1, hash: GENESIS }));
  const leaf = (unitId: string) => h("leaf:" + canonical({ unitId, seq: 1, hash: GENESIS }));
  const expected = h("node:" + h("node:" + leaf("a") + leaf("b")) + h("node:" + leaf("c") + leaf("c")));
  expect(await merkleRoot(heads)).toBe(expected); expect(await merkleRoot([...heads].reverse())).toBe(expected);
  expect(await merkleRoot([])).toBe(h("empty:pulsegrid-audit-v1"));
  await expect(merkleRoot([heads[0], heads[0]])).rejects.toThrow();
});
