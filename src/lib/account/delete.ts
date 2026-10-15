import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { subscriptions, users } from "@/db/schema";
import type { CalendarClient } from "@/lib/google/calendar";

export interface DeleteAccountDeps {
  db: Db;
  /** null when Google access is already gone. */
  calendar: CalendarClient | null;
  /** Revokes the Google grant (access + refresh token). null when unavailable. */
  revokeGoogle: (() => Promise<void>) | null;
}

export interface DeleteAccountResult {
  googleRevoked: boolean;
  calendarEventsRemoved: number;
  calendarEventsLeft: number;
}

/**
 * SPEC U8 / ARCHITECTURE §8: remove our calendar events, revoke Google access,
 * then hard-delete the user. Everything else (sessions, encrypted tokens, scan
 * state, extractions, subscriptions, events, reminders) cascades from `users`.
 * Google steps are best-effort: the data is deleted even if Google is unreachable.
 */
export async function deleteAccount(userId: string, deps: DeleteAccountDeps): Promise<DeleteAccountResult> {
  const { db } = deps;
  const result: DeleteAccountResult = { googleRevoked: false, calendarEventsRemoved: 0, calendarEventsLeft: 0 };

  const withEvents = await db
    .select({ eventId: subscriptions.googleEventId })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), isNotNull(subscriptions.googleEventId)));
  for (const { eventId } of withEvents) {
    try {
      if (!deps.calendar || !eventId) throw new Error("no calendar access");
      await deps.calendar.remove(eventId);
      result.calendarEventsRemoved++;
    } catch {
      result.calendarEventsLeft++;
    }
  }

  // Revoke last: the calendar cleanup above needs the token.
  if (deps.revokeGoogle) {
    try {
      await deps.revokeGoogle();
      result.googleRevoked = true;
    } catch {
      // Reported to the user with a link to revoke manually.
    }
  }

  await db.delete(users).where(eq(users.id, userId));
  return result;
}

/** Revokes a Google OAuth token; revoking the access token also revokes its refresh token. */
export async function revokeGoogleToken(token: string): Promise<void> {
  const res = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  // 400 invalid_token means it's already revoked/expired: nothing left to do.
  if (!res.ok && res.status !== 400) throw new Error(`Google revoke failed: HTTP ${res.status}`);
}
