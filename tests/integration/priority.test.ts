import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool } from "@/db/client";
import { subscriptions, users } from "@/db/schema";
import { env } from "@/env";
import { verifyReviewToken } from "@/lib/crypto";
import type { EmailSender, OutgoingEmail } from "@/lib/reminders/email";
import { applyReviewAnswer, recomputePriorities } from "@/lib/priority/recompute";
import { runRemindersDispatch, runRemindersPlan } from "@/worker/jobs/reminders";

describe("priority + review answers", () => {
  let userId: string;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    await pool.query("DELETE FROM users WHERE id LIKE 'test-%'");
    userId = `test-${randomUUID()}`;
    await db.insert(users).values({ id: userId, name: "Test", email: `${userId}@example.com`, timezone: "UTC" });
    for (const [name, category, amountMinor] of [
      ["Netflix", "video", 1799],
      ["Hulu", "video", 999],
      ["Max", "video", 1699],
      ["Spotify", "music", 1199],
    ] as const) {
      const [s] = await db
        .insert(subscriptions)
        .values({
          userId,
          merchantKey: name.toLowerCase(),
          merchantName: name,
          category,
          status: "active",
          amountMinor,
          currency: "USD",
          billingCycle: "monthly",
          nextChargeDate: "2026-11-20",
        })
        .returning({ id: subscriptions.id });
      ids[name] = s.id;
    }
  });

  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id LIKE 'test-%'");
    await pool.end();
  });

  const get = async (name: string) => (await db.select().from(subscriptions).where(eq(subscriptions.id, ids[name])))[0];

  it("scores relative to the user's other subscriptions", async () => {
    await recomputePriorities(db, userId);
    const netflix = await get("Netflix");
    expect(netflix.priorityFactors).toMatchObject({ base: 50, review: 0, overlap: -10, overlapCount: 3 });
    expect((await get("Spotify")).priorityFactors).toMatchObject({ overlap: 0 });
  });

  it("applies answers and rescoring; refuses another user's subscription", async () => {
    expect(await applyReviewAnswer(db, userId, ids.Netflix, "keep")).toBe(true);
    expect(await get("Netflix")).toMatchObject({ reviewAnswer: "keep" });
    expect((await get("Netflix")).priorityFactors).toMatchObject({ review: 35 });

    expect(await applyReviewAnswer(db, "test-someone-else", ids.Netflix, "cancel")).toBe(false);
    expect(await get("Netflix")).toMatchObject({ reviewAnswer: "keep" });
  });

  it("puts signed Keep / Cancel / Not sure links and the priority in reminder emails", async () => {
    await recomputePriorities(db, userId);
    await runRemindersPlan(db, ids.Hulu, new Date("2026-10-15T12:00:00Z"));
    const sent: OutgoingEmail[] = [];
    const sender: EmailSender = { send: async (e) => (sent.push(e), { id: "x" }) };
    await runRemindersDispatch(db, sender, () => new Date("2026-11-06T12:00:00Z"));

    expect(sent).toHaveLength(1);
    const links = [...sent[0].html.matchAll(/\/review\/([^"?]+)\?a=(keep|cancel|not_sure)/g)];
    expect(links.map((m) => m[2])).toEqual(["keep", "cancel", "not_sure"]);
    const token = verifyReviewToken(links[0][1], env.ACTION_TOKEN_SECRET);
    expect(token).toMatchObject({ ok: true, payload: { u: userId, s: ids.Hulu } });
    expect(sent[0].html).toContain("Priority");
    expect(sent[0].html).toContain("One of 3 video subscriptions");
  });
});
