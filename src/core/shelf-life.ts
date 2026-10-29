import { PRODUCTS, type Product } from "./domain";
import { instant, invalid, number, object, oneOf } from "./validation";

export const DAY_MS = 86_400_000;
const duration = object({ days: number(1, 3660, true) });
const year = object({ calendarYears: oneOf([1]) });
const parseRules = object({ PRBC_SAGM: duration, PRBC_CPDA1: duration, PLATELETS_CLOSED: duration, FFP_FROZEN: year });
export type ShelfLifeRules = ReturnType<typeof parseRules>;
export const DEFAULT_SHELF_LIFE: ShelfLifeRules = Object.freeze({ PRBC_SAGM: Object.freeze({ days: 42 }), PRBC_CPDA1: Object.freeze({ days: 35 }), PLATELETS_CLOSED: Object.freeze({ days: 5 }), FFP_FROZEN: Object.freeze({ calendarYears: 1 }) });
export function calculateExpiry(collectedAt: string, product: Product, config: ShelfLifeRules = DEFAULT_SHELF_LIFE): string {
  oneOf(PRODUCTS)(product); const rules = parseRules(config);
  const date = new Date(instant(collectedAt));
  if (product === "FFP_FROZEN") {
    const month = date.getUTCMonth();
    date.setUTCFullYear(date.getUTCFullYear() + rules.FFP_FROZEN.calendarYears);
    if (date.getUTCMonth() !== month) date.setUTCDate(0); // Feb 29 -> Feb 28.
  } else date.setTime(date.getTime() + rules[product].days * DAY_MS);
  if (!Number.isFinite(date.getTime())) invalid("expiry", "outside supported calendar");
  return date.toISOString();
}
export function isExpired(expiresAt: string, now: string): boolean { return Date.parse(instant(now)) >= Date.parse(instant(expiresAt)); }
