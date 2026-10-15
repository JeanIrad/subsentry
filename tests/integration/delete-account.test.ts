import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool } from "@/db/client";
import { extractions, gmailSyncState, processedMessages, reminders, subscriptions, users } from "@/db/schema";
import { deleteAccount } from "@/lib/account/delete";
import type { CalendarClient } from "@/lib/google/calendar";

describe("deleteAccount", () => {
  let me: string;
  let other: string;

  async function seedUser(id: string) {
    await db.insert(users).values({ id, name: "T", email: `${id}@example.com` });
    await db.insert(gmailSyncState).values({ userId: id, backfillStatus: "done" });
    await db.insert(processedMessages).values({ userId: id, gmailMessageId: "m1" });
    const [x] = await db
      .insert(extractions)
      .values({ userId: id, gmailMessageId: "m1", sentAt: new Date(), kind: "receipt", payload: {}, confidence: 0.9, model: "fake" })
      .returning({ id: extractions.id });
    const [s] = await db
      .insert(subscriptions)
      .values({ userId: id, merchantKey: "spotify", merchantName: "Spotify", googleEventId: `evt-${id}` })
      .returning({ id: subscriptions.id });
    await db.insert(reminders).values({ subscriptionId: s.id, chargeDate: "2026-11-20", offsetDays: 7, sendAt: new Date() });
    return { extractionId: x.id, subscriptionId: s.id };
  }

  beforeEach(async () => {
    await pool.query("DELETE FROM users WHERE id LIKE 'test-%'");
    me = `test-${randomUUID()}`;
    other = `test-${randomUUID()}`;
    await seedUser(me);
    await seedUser(other);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id LIKE 'test-%'");
    await pool.end();
  });

  const rowCount = async (userId: string) => {
    const [r] = await db.execute<{ n: number }>(sql`
      SELECT (SELECT count(*) FROM users WHERE id = ${userId})
           + (SELECT count(*) FROM gmail_sync_state WHERE user_id = ${userId})
           + (SELECT count(*) FROM processed_messages WHERE user_id = ${userId})
           + (SELECT count(*) FROM extractions WHERE user_id = ${userId})
           + (SELECT count(*) FROM subscriptions WHERE user_id = ${userId})
           + (SELECT count(*) FROM reminders r JOIN subscriptions s ON s.id = r.subscription_id WHERE s.user_id = ${userId})
           AS n`).then((res) => res.rows);
    return Number(r.n);
  };

  it("removes calendar events, revokes Google, and deletes every row of that user only", async () => {
    const removed: string[] = [];
    const calendar: CalendarClient = {
      create: async () => "x",
      update: async () => true,
      remove: async (id) => void removed.push(id),
    };
    let revoked = false;
    const result = await deleteAccount(me, { db, calendar, revokeGoogle: async () => void (revoked = true) });

    expect(result).toEqual({ googleRevoked: true, calendarEventsRemoved: 1, calendarEventsLeft: 0 });
    expect(removed).toEqual([`evt-${me}`]);
    expect(revoked).toBe(true);
    expect(await rowCount(me)).toBe(0);
    expect(await rowCount(other)).toBe(6);
  });

  it("still deletes the data when Google is unreachable", async () => {
    const result = await deleteAccount(me, {
      db,
      calendar: null,
      revokeGoogle: async () => {
        throw new Error("network down");
      },
    });
    expect(result).toEqual({ googleRevoked: false, calendarEventsRemoved: 0, calendarEventsLeft: 1 });
    expect(await rowCount(me)).toBe(0);
    expect(await db.select().from(users).where(inArray(users.id, [other]))).toHaveLength(1);
    expect(await db.select().from(subscriptions).where(eq(subscriptions.userId, other))).toHaveLength(1);
  });
});
