import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool } from "@/db/client";
import { extractions, subscriptionEvents, subscriptions, users } from "@/db/schema";
import { mergeExtraction, recomputeSubscription } from "@/lib/ledger/merge";

const NOW = new Date("2026-10-15T12:00:00Z");

describe("ledger merge", () => {
  let userId: string;

  beforeEach(async () => {
    userId = `test-${randomUUID()}`;
    await db.insert(users).values({ id: userId, name: "Test", email: `${userId}@example.com`, timezone: "America/New_York" });
  });

  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id LIKE 'test-%'");
    await pool.end();
  });

  async function extraction(kind: (typeof extractions.$inferInsert)["kind"], sent: string, p: Record<string, unknown>, confidence = 0.9) {
    const [row] = await db
      .insert(extractions)
      .values({
        userId,
        gmailMessageId: randomUUID(),
        sentAt: new Date(`${sent}T12:00:00Z`),
        kind,
        confidence,
        model: "fake",
        payload: {
          merchant: "Spotify",
          plan: null,
          amount_minor: null,
          currency: null,
          billing_cycle: null,
          charge_date: null,
          next_charge_date: null,
          trial_end_date: null,
          cancel_url: null,
          ...p,
        },
      })
      .returning({ id: extractions.id });
    return row.id;
  }

  const subs = () => db.select().from(subscriptions).where(eq(subscriptions.userId, userId));

  it("merges name variants into one subscription with a projected next charge", async () => {
    const a = await extraction("receipt", "2026-09-04", {
      merchant: "SPOTIFY AB",
      amount_minor: 1199,
      currency: "USD",
      billing_cycle: "monthly",
      charge_date: "2026-09-04",
    });
    const b = await extraction("receipt", "2026-10-04", { merchant: "Spotify", plan: "Premium Individual", amount_minor: 1199, currency: "USD", charge_date: "2026-10-04" });
    const first = await mergeExtraction(db, a, NOW);
    const second = await mergeExtraction(db, b, NOW);

    const rows = await subs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      merchantKey: "spotify",
      merchantName: "Spotify",
      planName: "Premium Individual",
      status: "active",
      amountMinor: 1199,
      category: "music",
      lastChargeDate: "2026-10-04",
      nextChargeDate: "2026-11-04",
      needsReview: false,
    });
    expect(first?.nextChargeChanged).toBe(true); // null → 2026-11-04
    expect(second?.nextChargeChanged).toBe(false); // still 2026-11-04
  });

  it("gives the same result whatever order extractions arrive in, and is idempotent", async () => {
    const receipt = await extraction("receipt", "2026-09-04", { amount_minor: 1199, currency: "USD", billing_cycle: "monthly", charge_date: "2026-09-04" });
    const cancel = await extraction("cancellation_confirmation", "2026-10-01", {});
    await mergeExtraction(db, cancel, NOW);
    await mergeExtraction(db, receipt, NOW);
    await mergeExtraction(db, receipt, NOW); // duplicate delivery

    const [sub] = await subs();
    expect(sub).toMatchObject({ status: "canceled", nextChargeDate: null });
    const events = await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.subscriptionId, sub.id));
    expect(events).toHaveLength(2);
  });

  it("never lets an email overwrite a field the user edited", async () => {
    const first = await extraction("receipt", "2026-09-04", { amount_minor: 1199, currency: "USD", billing_cycle: "monthly", charge_date: "2026-09-04" });
    await mergeExtraction(db, first, NOW);
    const [sub] = await subs();
    await db
      .update(subscriptions)
      .set({ userOverrides: { amountMinor: 999, merchantName: "Spotify Family" } })
      .where(eq(subscriptions.id, sub.id));

    const later = await extraction("price_change", "2026-10-01", { amount_minor: 1299, currency: "USD" });
    await mergeExtraction(db, later, NOW);
    const [after] = await subs();
    expect(after).toMatchObject({ amountMinor: 999, merchantName: "Spotify Family", priceChangedAt: new Date("2026-10-01T12:00:00Z") });
  });

  it("flags low-confidence subscriptions for review until the user confirms", async () => {
    const x = await extraction("receipt", "2026-10-01", { amount_minor: 500, currency: "USD", billing_cycle: "monthly" }, 0.4);
    await mergeExtraction(db, x, NOW);
    const [sub] = await subs();
    expect(sub).toMatchObject({ needsReview: true, reviewReason: "low_confidence" });

    await db.update(subscriptions).set({ userOverrides: { status: "active" } }).where(eq(subscriptions.id, sub.id));
    await recomputeSubscription(db, sub.id, NOW);
    const [confirmed] = await subs();
    expect(confirmed).toMatchObject({ needsReview: false, reviewReason: null, status: "active" });
  });

  it("ignores non-subscription extractions and ones without a merchant", async () => {
    const noise = await extraction("not_subscription", "2026-10-01", {});
    const noMerchant = await extraction("receipt", "2026-10-01", { merchant: null });
    expect(await mergeExtraction(db, noise, NOW)).toBeNull();
    expect(await mergeExtraction(db, noMerchant, NOW)).toBeNull();
    expect(await subs()).toHaveLength(0);
  });
});
