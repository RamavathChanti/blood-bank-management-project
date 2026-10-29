import { COMPONENTS, GROUPS, type Component, type Group } from "./domain";

export const PUBLIC_DISTRICTS = ["Mumbai City", "Mumbai Suburban", "Thane", "Pune"] as const;
export const AVAILABILITY_BANDS = ["NONE", "LOW", "MODERATE", "HIGH"] as const;
export type AvailabilityBand = typeof AVAILABILITY_BANDS[number];
export type PublicBoard = {
  schema: 1;
  generatedAt: string;
  source: "synthetic-registry";
  cells: { district: typeof PUBLIC_DISTRICTS[number]; group: Group; component: Component; band: AvailabilityBand }[];
};
// Teaching thresholds: exact internal counts never cross the public boundary.
export function availabilityBand(count: number): AvailabilityBand {
  return count <= 0 ? "NONE" : count < 5 ? "LOW" : count < 15 ? "MODERATE" : "HIGH";
}
export function publicBoard(at: Date, counts: readonly { district: string; group: string; component: string; count: number }[]): PublicBoard {
  return { schema: 1, generatedAt: at.toISOString(), source: "synthetic-registry", cells: PUBLIC_DISTRICTS.flatMap(district => GROUPS.flatMap(group => COMPONENTS.map(component => ({ district, group, component, band: availabilityBand(counts.filter(row => row.district === district && row.group === group && row.component === component).reduce((sum, row) => sum + row.count, 0)) })))) };
}
export function cacheObservation(headers: Pick<Headers, "get">): string {
  const value = headers.get("x-vercel-cache")?.toUpperCase();
  return value && ["HIT", "MISS", "STALE", "BYPASS", "REVALIDATED"].includes(value) ? value : "unknown";
}
