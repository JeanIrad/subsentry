"use server";

import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { subscriptions } from "@/db/schema";
import { appUrl, env } from "@/env";
import { deleteAccount, revokeGoogleToken } from "@/lib/account/delete";
import { requireUser } from "@/lib/auth";
import { getGoogleAccessToken } from "@/lib/google/auth";
import { createCalendarClient } from "@/lib/google/calendar";
import { daysBetween, todayIn } from "@/lib/ledger/dates";
import { createResendSender, EmailPermanentError } from "@/lib/reminders/email";
import { renderReminderEmail } from "@/lib/reminders/email-template";
import { createReviewToken } from "@/lib/crypto";
import { priorityLevel } from "@/lib/priority/score";

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
          reviewUrl: `${appUrl}/review/${createReviewToken({ userId: user.id, subscriptionId: sub.id }, env.ACTION_TOKEN_SECRET)}`,
          priority: sub.priorityScore != null ? { level: priorityLevel(sub.priorityScore), reason: null } : null,
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
          reviewUrl: null,
          priority: null,
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

/** SPEC U8: disconnect Google and permanently delete everything. */
export async function deleteMyAccount(formData: FormData): Promise<void> {
  if (formData.get("confirm") !== "DELETE") return;
  const user = await requireUser();

  let token: string | null = null;
  try {
    token = await getGoogleAccessToken(user.id, []);
  } catch {
    // Already disconnected: nothing to clean up on Google's side.
  }
  const result = await deleteAccount(user.id, {
    db,
    calendar: token ? createCalendarClient(token) : null,
    revokeGoogle: token ? () => revokeGoogleToken(token) : null,
  });

  // The session row is gone with the user; clear the now-dangling cookie too.
  const jar = await cookies();
  for (const name of ["better-auth.session_token", "__Secure-better-auth.session_token"]) jar.delete(name);
  // Only warn when there was something on Google's side we couldn't clean up.
  const googleClean = (!token || result.googleRevoked) && result.calendarEventsLeft === 0;
  redirect(googleClean ? "/goodbye" : "/goodbye?google=1");
}
