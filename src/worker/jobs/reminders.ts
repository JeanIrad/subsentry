import { and, eq, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { reminders, subscriptions, users } from "@/db/schema";
import { appUrl } from "@/env";
import { daysBetween, todayIn } from "@/lib/ledger/dates";
import { EmailPermanentError, type EmailSender } from "@/lib/reminders/email";
import { renderReminderEmail } from "@/lib/reminders/email-template";
import { isRemindable, planReminders } from "@/lib/reminders/plan";

/**
 * Brings a subscription's pending reminders in line with its current state
 * (ARCHITECTURE §3.5). Idempotent: the unique key on (subscription,
 * charge_date, offset, channel) means a reminder row exists at most once, and
 * `sent` rows are never touched — so a reminder can never be sent twice.
 */
export async function runRemindersPlan(db: Db, subscriptionId: string, now = new Date()): Promise<number> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ sub: subscriptions, timezone: users.timezone })
      .from(subscriptions)
      .innerJoin(users, eq(users.id, subscriptions.userId))
      .where(eq(subscriptions.id, subscriptionId))
      .for("update", { of: subscriptions });
    if (!row) return 0;
    const { sub } = row;

    const [{ n }] = sub.nextChargeDate
      ? await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(reminders)
          .where(
            and(
              eq(reminders.subscriptionId, sub.id),
              eq(reminders.chargeDate, sub.nextChargeDate),
              inArray(reminders.status, ["pending", "sent"]),
            ),
          )
      : [{ n: 0 }];

    const desired = planReminders({
      status: sub.status,
      nextChargeDate: sub.nextChargeDate,
      needsReview: sub.needsReview,
      quiet: sub.quiet,
      dismissed: sub.dismissed,
      timezone: row.timezone,
      now,
      alreadyPlanned: n > 0,
    });

    // Cancel pending reminders that no longer apply (date moved, subscription
    // canceled/hidden/quiet/unconfirmed, or trial ↔ paid changed the offsets).
    const keep = desired.map((d) => `${d.chargeDate}:${d.offsetDays}`);
    await tx
      .update(reminders)
      .set({ status: "canceled" })
      .where(
        and(
          eq(reminders.subscriptionId, sub.id),
          eq(reminders.status, "pending"),
          keep.length > 0
            ? notInArray(sql`${reminders.chargeDate}::text || ':' || ${reminders.offsetDays}`, keep)
            : sql`true`,
        ),
      );

    if (desired.length > 0) {
      await tx
        .insert(reminders)
        .values(desired.map((d) => ({ subscriptionId: sub.id, ...d, channel: "email" as const })))
        .onConflictDoUpdate({
          target: [reminders.subscriptionId, reminders.chargeDate, reminders.offsetDays, reminders.channel],
          // Revive a reminder canceled earlier (e.g. hidden, then restored).
          // Never touches `sent` or `failed` rows.
          set: { status: "pending", sendAt: sql`excluded.send_at`, error: null },
          setWhere: eq(reminders.status, "canceled"),
        });
    }
    return desired.length;
  });
}

const MAX_ATTEMPTS = 5;

/** Sends every due reminder. Each one is claimed with FOR UPDATE SKIP LOCKED,
 *  so overlapping runs never pick the same row. */
export async function runRemindersDispatch(
  db: Db,
  sender: EmailSender,
  now = () => new Date(),
): Promise<{ sent: number; skipped: number; failed: number }> {
  const result = { sent: 0, skipped: 0, failed: 0 };
  for (let i = 0; i < 200; i++) {
    const done = await db.transaction(async (tx) => {
      const [r] = await tx
        .select({ reminder: reminders, sub: subscriptions, email: users.email, timezone: users.timezone })
        .from(reminders)
        .innerJoin(subscriptions, eq(subscriptions.id, reminders.subscriptionId))
        .innerJoin(users, eq(users.id, subscriptions.userId))
        .where(and(eq(reminders.status, "pending"), sql`${reminders.sendAt} <= ${now().toISOString()}`))
        .orderBy(reminders.sendAt)
        .limit(1)
        .for("update", { of: reminders, skipLocked: true });
      if (!r) return true;
      const { reminder, sub } = r;
      const mark = (set: Partial<typeof reminders.$inferInsert>) =>
        tx.update(reminders).set(set).where(eq(reminders.id, reminder.id));

      // Re-check at send time: things may have changed since planning.
      if (!isRemindable(sub) || sub.nextChargeDate !== reminder.chargeDate || (sub.status !== "active" && sub.status !== "trial")) {
        await mark({ status: "canceled" });
        result.skipped++;
        return false;
      }

      const email = renderReminderEmail({
        merchantName: sub.merchantName,
        planName: sub.planName,
        status: sub.status,
        amountMinor: sub.amountMinor,
        currency: sub.currency,
        cycle: sub.billingCycle,
        chargeDate: reminder.chargeDate,
        daysLeft: daysBetween(todayIn(r.timezone, now()), reminder.chargeDate),
        priceChanged: sub.priceChangedAt != null && now().getTime() - sub.priceChangedAt.getTime() < 60 * 86_400_000,
        cancelUrl: sub.cancelUrl,
        detailUrl: `${appUrl}/subscriptions/${sub.id}`,
      });

      try {
        await sender.send({ to: r.email, ...email, idempotencyKey: `reminder-${reminder.id}` });
        await mark({ status: "sent", sentAt: now(), attempts: reminder.attempts + 1, error: null });
        result.sent++;
      } catch (err) {
        const attempts = reminder.attempts + 1;
        const message = err instanceof Error ? err.message.slice(0, 500) : "send failed";
        if (err instanceof EmailPermanentError || attempts >= MAX_ATTEMPTS) {
          await mark({ status: "failed", attempts, error: message });
          result.failed++;
        } else {
          // Back off: 15 min, 30, 60, 120…
          await mark({ attempts, error: message, sendAt: new Date(now().getTime() + 15 * 60_000 * 2 ** (attempts - 1)) });
        }
      }
      return false;
    });
    if (done) break;
  }
  return result;
}

/** Subscriptions worth re-checking daily: anything that could still remind,
 *  or that has a calendar event or pending reminder to clean up. */
export async function subscriptionsToRefresh(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: subscriptions.id })
    .from(subscriptions)
    .leftJoin(reminders, and(eq(reminders.subscriptionId, subscriptions.id), eq(reminders.status, "pending")))
    .where(
      or(
        and(ne(subscriptions.status, "canceled"), eq(subscriptions.dismissed, false)),
        sql`${subscriptions.googleEventId} IS NOT NULL`,
        sql`${reminders.id} IS NOT NULL`,
      ),
    );
  return rows.map((r) => r.id);
}
