import { describe, expect, it } from "vitest";
import { availabilityBand, cacheObservation, publicBoard } from "../../src/core/public-board";

describe("public disclosure boundary", () => {
  it.each([[0, "NONE"], [1, "LOW"], [4, "LOW"], [5, "MODERATE"], [14, "MODERATE"], [15, "HIGH"], [100, "HIGH"]])("bands %s as %s", (count, band) => expect(availabilityBand(Number(count))).toBe(band));
  it("emits a fixed complete matrix and drops unknown districts, groups, components and extra fields", () => {
    const input = [
      { district: "Pune", group: "O-", component: "PRBC", count: 3, donorId: "private", unitId: "secret", nickname: "private" },
      { district: "Other", group: "O-", component: "PRBC", count: 50 },
      { district: "Pune", group: "INVALID", component: "PRBC", count: 50 }
    ];
    const board = publicBoard(new Date("2026-10-29T00:00:00Z"), input);
    expect(board.cells).toHaveLength(96);
    expect(Object.keys(board)).toEqual(["schema", "generatedAt", "source", "cells"]);
    expect(board.cells.every(cell => Object.keys(cell).join(",") === "district,group,component,band")).toBe(true);
    expect(board.cells.find(cell => cell.district === "Pune" && cell.group === "O-" && cell.component === "PRBC")?.band).toBe("LOW");
    expect(JSON.stringify(board)).not.toMatch(/private|secret|Other|INVALID|count|donorId|unitId/);
  });
  it.each(["HIT", "MISS", "STALE", "BYPASS", "REVALIDATED", null, "invented"])("reports only an observed supported CDN header: %s", value => {
    const headers = new Headers(value ? { "x-vercel-cache": value } : {});
    expect(cacheObservation(headers)).toBe(value && value !== "invented" ? value : "unknown");
  });
});
