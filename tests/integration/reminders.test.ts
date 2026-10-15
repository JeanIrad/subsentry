import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool } from "@/db/client";
import { reminders, subscriptions, users } from "@/db/schema";
import type { CalendarClient, CalendarEventInput } from "@/lib/google/calendar";
import { EmailPermanentError, type EmailSender, type OutgoingEmail } from "@/lib/reminders/email";
import { runCalendarUpsert } from "@/worker/jobs/calendar-upsert";
import { runRemindersDispatch, runRemindersPlan } from "@/worker/jobs/reminders";

const NOW = new Date("2026-10-15T12:00:00Z");

describe("reminders", () => {
  let userId: string;
  let subId: string;

  beforeEach(async () => {
    // Dispatch is global, so start every test from an empty slate (test DB only).
    await pool.query("DELETE FROM users WHERE id LIKE 'test-%'");
    userId = `test-${randomUUID()}`;
    await db.insert(users).values({ id: userId, name: "Test", email: `${userId}@example.com`, timezone: "America/New_York" });
    const [s] = await db
      .insert(subscriptions)
      .values({
        userId,
        merchantKey: "spotify",
        merchantName: "Spotify <b>",
        status: "active",
        amountMinor: 1199,
        currency: "USD",
        billingCycle: "monthly",
        nextChargeDate: "2026-11-20",
      })
      .returning({ id: subscriptions.id });
    subId = s.id;
  });

  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id LIKE 'test-%'");
    await pool.end();
  });

  const rows = () => db.select().from(reminders).where(eq(reminders.subscriptionId, subId)).orderBy(reminders.sendAt);
  const setSub = (patch: Partial<typeof subscriptions.$inferInsert>) =>
    db.update(subscriptions).set(patch).where(eq(subscriptions.id, subId));

  function fakeSender(fail?: Error) {
    const sent: OutgoingEmail[] = [];
    const sender: EmailSender = {
      send: async (e) => {
        if (fail) throw fail;
        sent.push(e);
        return { id: `email-${sent.length}` };
      },
    };
    return { sender, sent };
  }

  it("plans 14/7/1 reminders and is idempotent", async () => {
    expect(await runRemindersPlan(db, subId, NOW)).toBe(3);
    await runRemindersPlan(db, subId, NOW);
    const r = await rows();
    expect(r.map((x) => [x.offsetDays, x.status, x.chargeDate])).toEqual([
      [14, "pending", "2026-11-20"],
      [7, "pending", "2026-11-20"],
      [1, "pending", "2026-11-20"],
    ]);
  });

  it("cancels pending reminders when the charge date moves, and plans the new ones", async () => {
    await runRemindersPlan(db, subId, NOW);
    await setSub({ nextChargeDate: "2026-11-27" });
    await runRemindersPlan(db, subId, NOW);
    const r = await rows();
    expect(r.filter((x) => x.status === "pending").map((x) => x.chargeDate)).toEqual(["2026-11-27", "2026-11-27", "2026-11-27"]);
    expect(r.filter((x) => x.status === "canceled")).toHaveLength(3);
  });

  it("cancels everything when the subscription is canceled, hidden, quiet or unconfirmed, and revives on restore", async () => {
    await runRemindersPlan(db, subId, NOW);
    for (const patch of [{ quiet: true }, { dismissed: true }, { needsReview: true }, { status: "canceled" as const }]) {
      await setSub(patch);
      await runRemindersPlan(db, subId, NOW);
      expect((await rows()).every((x) => x.status === "canceled")).toBe(true);
      await setSub({ quiet: false, dismissed: false, needsReview: false, status: "active" });
    }
    await runRemindersPlan(db, subId, NOW);
    expect((await rows()).filter((x) => x.status === "pending")).toHaveLength(3);
  });

  it("sends each due reminder exactly once, with escaped content", async () => {
    await runRemindersPlan(db, subId, NOW);
    const { sender, sent } = fakeSender();
    const at = () => new Date("2026-11-13T15:00:00Z"); // after the 14d and 7d send times
    expect(await runRemindersDispatch(db, sender, at)).toEqual({ sent: 2, skipped: 0, failed: 0 });
    expect(await runRemindersDispatch(db, sender, at)).toEqual({ sent: 0, skipped: 0, failed: 0 });

    expect(sent).toHaveLength(2);
    expect(sent[0].to).toBe(`${userId}@example.com`);
    // Days left are counted from when it's actually sent (here Nov 13), not when planned.
    expect(sent[0].subject).toBe("Spotify <b> renews in 7 days for $11.99");
    expect(sent[0].html).toContain("Spotify &lt;b&gt;");
    expect(sent[0].html).not.toContain("Spotify <b>");
    expect(new Set(sent.map((e) => e.idempotencyKey)).size).toBe(2);

    const r = await rows();
    expect(r.map((x) => x.status)).toEqual(["sent", "sent", "pending"]);
    // Re-planning never resurrects or duplicates sent reminders.
    await runRemindersPlan(db, subId, at());
    expect((await rows()).map((x) => x.status)).toEqual(["sent", "sent", "pending"]);
  });

  it("skips a due reminder whose subscription changed after planning", async () => {
    await runRemindersPlan(db, subId, NOW);
    await setSub({ status: "canceled", nextChargeDate: null });
    const { sender, sent } = fakeSender();
    const r = await runRemindersDispatch(db, sender, () => new Date("2026-11-30T00:00:00Z"));
    expect(r).toEqual({ sent: 0, skipped: 3, failed: 0 });
    expect(sent).toHaveLength(0);
  });

  it("marks permanent failures failed and backs off on transient ones", async () => {
    await runRemindersPlan(db, subId, NOW);
    const at = () => new Date("2026-11-06T15:00:00Z");
    await runRemindersDispatch(db, fakeSender(new Error("timeout")).sender, at);
    let [first] = await rows();
    expect(first).toMatchObject({ status: "pending", attempts: 1, error: "timeout" });
    expect(first.sendAt.getTime()).toBe(at().getTime() + 15 * 60_000);

    await runRemindersDispatch(db, fakeSender(new EmailPermanentError("not verified")).sender, () => new Date("2026-11-06T16:00:00Z"));
    [first] = await rows();
    expect(first).toMatchObject({ status: "failed", attempts: 2, error: "not verified" });
  });

  describe("calendar", () => {
    function fakeCalendar() {
      const events = new Map<string, CalendarEventInput>();
      let n = 0;
      const cal: CalendarClient = {
        create: async (e) => {
          const id = `evt-${++n}`;
          events.set(id, e);
          return id;
        },
        update: async (id, e) => {
          if (!events.has(id)) return false;
          events.set(id, e);
          return true;
        },
        remove: async (id) => {
          events.delete(id);
        },
      };
      return { cal, events };
    }
    const sub = async () => (await db.select().from(subscriptions).where(eq(subscriptions.id, subId)))[0];

    it("creates one event, updates it in place, and removes it when canceled", async () => {
      const { cal, events } = fakeCalendar();
      expect(await runCalendarUpsert(db, subId, cal, NOW)).toBe("created");
      expect([...events.values()][0]).toMatchObject({
        title: "💳 Spotify <b> renews · $11.99",
        date: "2026-11-20",
        alertMinutes: [14 * 1440 - 540, 7 * 1440 - 540, 1440 - 540],
      });

      await setSub({ nextChargeDate: "2026-11-27" });
      expect(await runCalendarUpsert(db, subId, cal, NOW)).toBe("updated");
      expect(events.size).toBe(1);
      expect([...events.values()][0].date).toBe("2026-11-27");

      await setSub({ status: "canceled" });
      expect(await runCalendarUpsert(db, subId, cal, NOW)).toBe("removed");
      expect(events.size).toBe(0);
      expect(await sub()).toMatchObject({ googleEventId: null, googleEventDate: null });
    });

    it("respects an event the user deleted until the date moves", async () => {
      const { cal, events } = fakeCalendar();
      await runCalendarUpsert(db, subId, cal, NOW);
      events.clear(); // user deletes it in Google Calendar
      expect(await runCalendarUpsert(db, subId, cal, NOW)).toBe("kept_deleted");
      expect(await runCalendarUpsert(db, subId, cal, NOW)).toBe("kept_deleted");
      expect(events.size).toBe(0);

      await setSub({ nextChargeDate: "2026-12-20" });
      expect(await runCalendarUpsert(db, subId, cal, NOW)).toBe("created");
      expect(events.size).toBe(1);
    });

    it("anchors trial alerts a day earlier", async () => {
      const { cal, events } = fakeCalendar();
      await setSub({ status: "trial" });
      await runCalendarUpsert(db, subId, cal, NOW);
      expect([...events.values()][0]).toMatchObject({
        title: "⏳ Spotify <b> trial ends · then $11.99/mo",
        alertMinutes: [8 * 1440 - 540, 4 * 1440 - 540, 2 * 1440 - 540],
      });
    });
  });
});
