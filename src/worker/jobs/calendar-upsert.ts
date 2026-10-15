import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { subscriptions, users } from "@/db/schema";
import { appUrl } from "@/env";
import { todayIn } from "@/lib/ledger/dates";
import type { CalendarClient, CalendarEventInput } from "@/lib/google/calendar";
import { formatMoney } from "@/lib/money";
import { isRemindable, PAID_OFFSETS, SEND_HOUR, TRIAL_OFFSETS } from "@/lib/reminders/plan";

const PER: Record<string, string> = { weekly: "/wk", monthly: "/mo", quarterly: "/qtr", yearly: "/yr" };

export type CalendarOutcome = "created" | "updated" | "removed" | "kept_deleted" | "none";

/**
 * One all-day event per upcoming charge (ARCHITECTURE §3.7), with the same
 * 14/7/1 (or 7/3/1 for trials) cadence as popup alerts. If the user deletes
 * the event we leave it deleted until the charge date moves.
 */
export async function runCalendarUpsert(db: Db, subscriptionId: string, cal: CalendarClient, now = new Date()): Promise<CalendarOutcome> {
  const [row] = await db
    .select({ sub: subscriptions, timezone: users.timezone })
    .from(subscriptions)
    .innerJoin(users, eq(users.id, subscriptions.userId))
    .where(eq(subscriptions.id, subscriptionId));
  if (!row) return "none";
  const { sub } = row;
  const save = (googleEventId: string | null, googleEventDate: string | null) =>
    db.update(subscriptions).set({ googleEventId, googleEventDate }).where(eq(subscriptions.id, sub.id));

  const date = sub.nextChargeDate;
  const wanted = isRemindable(sub) && date != null && date >= todayIn(row.timezone, now);

  if (!wanted || !date) {
    if (!sub.googleEventId) return "none";
    await cal.remove(sub.googleEventId);
    await save(null, null);
    return "removed";
  }

  const event = eventFor(sub, date);
  if (sub.googleEventId) {
    if (await cal.update(sub.googleEventId, event)) {
      await save(sub.googleEventId, date);
      return "updated";
    }
    // The user deleted it. Respect that for this date.
    if (sub.googleEventDate === date) {
      await save(null, date);
      return "kept_deleted";
    }
  } else if (sub.googleEventDate === date) {
    return "kept_deleted";
  }
  await save(await cal.create(event), date);
  return "created";
}

export function eventFor(sub: typeof subscriptions.$inferSelect, date: string): CalendarEventInput {
  const trial = sub.status === "trial";
  const price = sub.amountMinor != null && sub.currency ? formatMoney(sub.amountMinor, sub.currency) : null;
  const per = (sub.billingCycle && PER[sub.billingCycle]) || "";
  const title = trial
    ? `⏳ ${sub.merchantName} trial ends${price ? ` · then ${price}${per}` : ""}`
    : `💳 ${sub.merchantName} renews${price ? ` · ${price}` : ""}`;
  const description = [
    trial ? "Your free trial converts to a paid plan today unless you cancel." : "This subscription is expected to charge today.",
    sub.cancelUrl ? `Manage or cancel: ${sub.cancelUrl}` : null,
    `Open in SubSentry: ${appUrl}/subscriptions/${sub.id}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  // Alerts at 9:00 on each reminder day; for all-day events Google counts
  // minutes back from 00:00 of the event date. Trials anchor one day earlier.
  const shift = trial ? 1 : 0;
  const alertMinutes = (trial ? TRIAL_OFFSETS : PAID_OFFSETS).map((d) => (d + shift) * 1440 - SEND_HOUR * 60);
  return { subscriptionId: sub.id, title, description, date, alertMinutes };
}
