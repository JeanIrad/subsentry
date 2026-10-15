import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { subscriptions } from "@/db/schema";
import { daysBetween, monthlyEquivalent, todayIn } from "@/lib/ledger/dates";
import { overridesSchema } from "@/lib/ledger/merge";

export type SubscriptionRow = typeof subscriptions.$inferSelect;

export interface SubscriptionView {
  id: string;
  name: string;
  plan: string | null;
  status: SubscriptionRow["status"];
  category: string;
  amountMinor: number | null;
  currency: string | null;
  cycle: SubscriptionRow["billingCycle"];
  nextChargeDate: string | null;
  /** Days from today (user's timezone) to the next charge; negative = past. */
  daysUntil: number | null;
  trialEndDate: string | null;
  needsReview: boolean;
  reviewReason: SubscriptionRow["reviewReason"];
  cancelUrl: string | null;
  dismissed: boolean;
  /** Fields the user has edited. */
  edited: string[];
}

export function toView(row: SubscriptionRow, today: string): SubscriptionView {
  return {
    id: row.id,
    name: row.merchantName,
    plan: row.planName,
    status: row.status,
    category: row.category ?? "other",
    amountMinor: row.amountMinor,
    currency: row.currency,
    cycle: row.billingCycle,
    nextChargeDate: row.nextChargeDate,
    daysUntil: row.nextChargeDate ? daysBetween(today, row.nextChargeDate) : null,
    trialEndDate: row.trialEndDate,
    needsReview: row.needsReview,
    reviewReason: row.reviewReason,
    cancelUrl: row.cancelUrl,
    dismissed: row.dismissed,
    edited: Object.keys(overridesSchema.catch({}).parse(row.userOverrides)),
  };
}

export async function listSubscriptions(userId: string, timezone: string): Promise<SubscriptionView[]> {
  const today = todayIn(timezone);
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    // Soonest charge first; undated last.
    .orderBy(sql`${subscriptions.nextChargeDate} asc nulls last`, asc(subscriptions.merchantName));
  return rows.map((r) => toView(r, today));
}

export async function getSubscription(userId: string, id: string, timezone: string): Promise<SubscriptionView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.id, id), eq(subscriptions.userId, userId)));
  return row ? toView(row, todayIn(timezone)) : null;
}

export interface Totals {
  currency: string;
  monthlyMinor: number;
  yearlyMinor: number;
  count: number;
}

/** Recurring spend of active subscriptions, per currency (largest first).
 *  Trials and anything canceled, dismissed or unconfirmed are excluded. */
export function computeTotals(subs: SubscriptionView[]): Totals[] {
  const by = new Map<string, Totals>();
  for (const s of subs) {
    if (s.dismissed || s.status !== "active" || s.needsReview || s.amountMinor == null || !s.currency) continue;
    const monthly = monthlyEquivalent(s.amountMinor, s.cycle);
    if (monthly == null) continue;
    const t = by.get(s.currency) ?? { currency: s.currency, monthlyMinor: 0, yearlyMinor: 0, count: 0 };
    t.monthlyMinor += monthly;
    t.yearlyMinor += monthly * 12;
    t.count += 1;
    by.set(s.currency, t);
  }
  return [...by.values()].sort((a, b) => b.monthlyMinor - a.monthlyMinor);
}
