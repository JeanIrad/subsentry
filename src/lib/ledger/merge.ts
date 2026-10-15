import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { extractions, subscriptionEvents, subscriptions, users } from "@/db/schema";
import { categoryFor, CATEGORIES } from "./categories";
import { todayIn } from "./dates";
import { foldEvents, type EventKind, type LedgerEvent, type SubscriptionState } from "./fold";
import { merchantKey } from "./normalize";

// Fields a user can edit. Stored in subscriptions.user_overrides and always
// applied on top of what emails say (CLAUDE.md hard rule).
export const overridesSchema = z
  .object({
    merchantName: z.string().trim().min(1).max(100),
    planName: z.string().trim().max(100).nullable(),
    amountMinor: z.number().int().nonnegative().nullable(),
    currency: z.string().length(3).nullable(),
    billingCycle: z.enum(["weekly", "monthly", "quarterly", "yearly", "other"]).nullable(),
    nextChargeDate: z.iso.date().nullable(),
    status: z.enum(["trial", "active", "canceled", "unknown"]),
    category: z.enum(CATEGORIES),
  })
  .partial();
export type Overrides = z.infer<typeof overridesSchema>;

const payloadSchema = z.object({
  merchant: z.string().nullable(),
  plan: z.string().nullable(),
  amount_minor: z.number().nullable(),
  currency: z.string().nullable(),
  billing_cycle: z.enum(["weekly", "monthly", "quarterly", "yearly", "other"]).nullable(),
  charge_date: z.string().nullable(),
  next_charge_date: z.string().nullable(),
  trial_end_date: z.string().nullable(),
  cancel_url: z.string().nullable(),
});

export interface MergeResult {
  subscriptionId: string;
  nextChargeChanged: boolean;
}

/**
 * Attaches an extraction to its subscription (creating it if needed) and
 * rebuilds the subscription. Idempotent: one event per extraction.
 */
export async function mergeExtraction(db: Db, extractionId: string, now = new Date()): Promise<MergeResult | null> {
  const [x] = await db.select().from(extractions).where(eq(extractions.id, extractionId));
  if (!x || x.kind === "not_subscription") return null;
  const payload = payloadSchema.parse(x.payload);
  if (!payload.merchant) return null;

  const key = merchantKey(payload.merchant);
  // One subscription per merchant for now: plans change (upgrades), and a
  // renewal notice often omits the plan name that the receipt had.
  await db
    .insert(subscriptions)
    .values({ userId: x.userId, merchantKey: key, merchantName: payload.merchant, category: categoryFor(key) })
    .onConflictDoNothing();
  const [sub] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, x.userId), eq(subscriptions.merchantKey, key), eq(subscriptions.planKey, "")));

  await db
    .insert(subscriptionEvents)
    .values({ subscriptionId: sub.id, extractionId: x.id, kind: x.kind, data: x.payload })
    .onConflictDoNothing();

  return recomputeSubscription(db, sub.id, now);
}

/** Rebuilds one subscription from its events + the user's overrides. */
export async function recomputeSubscription(db: Db, subscriptionId: string, now = new Date()): Promise<MergeResult> {
  return db.transaction(async (tx) => {
    // Row lock: concurrent merges for the same subscription run one after
    // another, so the last writer always sees every committed event.
    const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).for("update");
    const [user] = await tx.select({ timezone: users.timezone }).from(users).where(eq(users.id, sub.userId));

    const rows = await tx
      .select({ kind: extractions.kind, sentAt: extractions.sentAt, confidence: extractions.confidence, payload: extractions.payload })
      .from(subscriptionEvents)
      .innerJoin(extractions, eq(subscriptionEvents.extractionId, extractions.id))
      .where(eq(subscriptionEvents.subscriptionId, subscriptionId));

    const events: LedgerEvent[] = rows.flatMap((r) => {
      const p = payloadSchema.safeParse(r.payload);
      if (!p.success || r.kind === "not_subscription") return [];
      return [
        {
          kind: r.kind as EventKind,
          sentAt: r.sentAt,
          confidence: r.confidence,
          merchant: p.data.merchant,
          plan: p.data.plan,
          amountMinor: p.data.amount_minor,
          currency: p.data.currency,
          billingCycle: p.data.billing_cycle,
          chargeDate: p.data.charge_date,
          nextChargeDate: p.data.next_charge_date,
          trialEndDate: p.data.trial_end_date,
          cancelUrl: p.data.cancel_url,
        },
      ];
    });

    const today = todayIn(user?.timezone ?? "UTC", now);
    const computed = events.length > 0 ? foldEvents(events, today) : null;
    const overrides = overridesSchema.catch({}).parse(sub.userOverrides);
    const next = applyOverrides(sub, computed, overrides);

    await tx.update(subscriptions).set(next).where(eq(subscriptions.id, subscriptionId));
    return { subscriptionId, nextChargeChanged: next.nextChargeDate !== sub.nextChargeDate };
  });
}

type SubRow = typeof subscriptions.$inferSelect;

function applyOverrides(sub: SubRow, c: SubscriptionState | null, o: Overrides) {
  const pick = <K extends keyof Overrides, V>(k: K, fromEmail: V): Overrides[K] | V =>
    k in o ? (o[k] as Overrides[K]) : fromEmail;
  // A user-confirmed status settles whatever made us unsure.
  const reviewed = "status" in o || "nextChargeDate" in o;
  return {
    merchantName: pick("merchantName", c?.merchantName ?? sub.merchantName) ?? sub.merchantName,
    planName: pick("planName", c?.planName ?? sub.planName),
    status: pick("status", c?.status ?? sub.status) ?? "unknown",
    amountMinor: pick("amountMinor", c?.amountMinor ?? sub.amountMinor),
    currency: pick("currency", c?.currency ?? sub.currency),
    billingCycle: pick("billingCycle", c?.billingCycle ?? sub.billingCycle),
    nextChargeDate: pick("nextChargeDate", c ? c.nextChargeDate : sub.nextChargeDate),
    category: pick("category", sub.category ?? categoryFor(sub.merchantKey)),
    lastChargeDate: c?.lastChargeDate ?? sub.lastChargeDate,
    trialEndDate: c ? c.trialEndDate : sub.trialEndDate,
    priceChangedAt: c?.priceChangedAt ?? sub.priceChangedAt,
    cancelUrl: c?.cancelUrl ?? sub.cancelUrl,
    needsReview: reviewed ? false : (c?.needsReview ?? sub.needsReview),
    reviewReason: reviewed ? null : c ? c.reviewReason : sub.reviewReason,
  };
}
