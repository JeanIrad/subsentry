import { tz } from "@date-fns/tz";
import { addMonths, addWeeks, differenceInCalendarDays, format, parseISO } from "date-fns";

// Calendar dates are "YYYY-MM-DD" strings in the user's timezone (CLAUDE.md).

export type Cycle = "weekly" | "monthly" | "quarterly" | "yearly" | "other";

/** Today's date in the given IANA timezone. */
export function todayIn(timezone: string, now: Date = new Date()): string {
  return format(now, "yyyy-MM-dd", { in: tz(timezone) });
}

/** The n-th charge after `anchor`. Always computed from the anchor, so
 *  Jan 31 → Feb 28 → Mar 31 (no drift to the 28th). */
export function addCycles(anchor: string, cycle: Cycle, n: number): string | null {
  const d = parseISO(anchor);
  switch (cycle) {
    case "weekly":
      return format(addWeeks(d, n), "yyyy-MM-dd");
    case "monthly":
      return format(addMonths(d, n), "yyyy-MM-dd");
    case "quarterly":
      return format(addMonths(d, 3 * n), "yyyy-MM-dd");
    case "yearly":
      return format(addMonths(d, 12 * n), "yyyy-MM-dd");
    case "other":
      return null;
  }
}

/** First charge strictly after `lastCharge` that falls on or after `today`. */
export function nextChargeFrom(lastCharge: string, cycle: Cycle, today: string): string | null {
  for (let n = 1; n <= 600; n++) {
    const d = addCycles(lastCharge, cycle, n);
    if (d === null) return null;
    if (d >= today) return d;
  }
  return null;
}

export function daysBetween(from: string, to: string): number {
  return differenceInCalendarDays(parseISO(to), parseISO(from));
}

/** Monthly-equivalent cost in minor units; null for irregular cycles. */
export function monthlyEquivalent(amountMinor: number, cycle: Cycle | null): number | null {
  switch (cycle) {
    case "weekly":
      return Math.round((amountMinor * 52) / 12);
    case "monthly":
      return amountMinor;
    case "quarterly":
      return Math.round(amountMinor / 3);
    case "yearly":
      return Math.round(amountMinor / 12);
    default:
      return null;
  }
}
