"use server";

import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { subscriptions } from "@/db/schema";
import { appUrl, env } from "@/env";
import { requireUser } from "@/lib/auth";
import { daysBetween, todayIn } from "@/lib/ledger/dates";
import { createResendSender, EmailPermanentError } from "@/lib/reminders/email";
import { renderReminderEmail } from "@/lib/reminders/email-template";

export interface TestEmailState {
  ok?: boolean;
  message?: string;
}

/** Sends one reminder email now, so the user can see what they'll get. */
export async function sendTestReminder(): Promise<TestEmailState> {
  const user = await requireUser();
  if (!env.RESEND_API_KEY) return { ok: false, message: "Email isn't set up on the server yet." };
  const today = todayIn(user.timezone ?? "UTC");

  // Use the user's soonest real charge so the preview is meaningful.
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, user.id),
        eq(subscriptions.dismissed, false),
        inArray(subscriptions.status, ["active", "trial"]),
        gte(subscriptions.nextChargeDate, today),
      ),
    )
    .orderBy(asc(subscriptions.nextChargeDate))
    .limit(1);

  const email = renderReminderEmail(
    sub?.nextChargeDate && (sub.status === "active" || sub.status === "trial")
      ? {
          merchantName: sub.merchantName,
          planName: sub.planName,
          status: sub.status,
          amountMinor: sub.amountMinor,
          currency: sub.currency,
          cycle: sub.billingCycle,
          chargeDate: sub.nextChargeDate,
          daysLeft: daysBetween(today, sub.nextChargeDate),
          priceChanged: false,
          cancelUrl: sub.cancelUrl,
          detailUrl: `${appUrl}/subscriptions/${sub.id}`,
        }
      : {
          merchantName: "Example Streaming",
          planName: "Premium",
          status: "trial",
          amountMinor: 1499,
          currency: "USD",
          cycle: "monthly",
          chargeDate: today,
          daysLeft: 3,
          priceChanged: false,
          cancelUrl: null,
          detailUrl: `${appUrl}/subscriptions`,
        },
  );

  try {
    await createResendSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM }).send({
      to: user.email,
      ...email,
      subject: `[Test] ${email.subject}`,
      // One test per minute at most, even on double-taps.
      idempotencyKey: `test-${user.id}-${Math.floor(Date.now() / 60_000)}`,
    });
    return { ok: true, message: `Sent to ${user.email}. Check your inbox (and spam, the first time).` };
  } catch (err) {
    if (err instanceof EmailPermanentError) {
      return {
        ok: false,
        message: `Couldn't send to ${user.email}: ${err.message}. Without a verified domain, Resend only delivers to the address you signed up to Resend with.`,
      };
    }
    return { ok: false, message: "Sending failed. Please try again in a minute." };
  }
}
