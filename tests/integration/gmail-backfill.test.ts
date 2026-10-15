import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool } from "@/db/client";
import { gmailSyncState, processedMessages, users } from "@/db/schema";
import type { GmailReader } from "@/lib/google/gmail";
import type { EmailExtractJob } from "@/lib/jobs/queues";
import { runGmailBackfill, runGmailSync } from "@/worker/jobs/gmail-backfill";

// Runs against the local docker Postgres (npm run test:integration).

function fakeGmail(pages: string[][], historyId = "1000"): GmailReader & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    getHistoryId: async () => historyId,
    getMessage: async () => null,
    listMessageIds: async (query, pageToken) => {
      queries.push(query);
      const i = pageToken ? Number(pageToken) : 0;
      return { ids: pages[i] ?? [], nextPageToken: i + 1 < pages.length ? String(i + 1) : undefined };
    },
  };
}

describe("runGmailBackfill", () => {
  let userId: string;
  let enqueued: EmailExtractJob[];
  const enqueueExtract = async (jobs: EmailExtractJob[]) => {
    enqueued.push(...jobs);
  };

  beforeEach(async () => {
    userId = `test-${randomUUID()}`;
    enqueued = [];
    await db.insert(users).values({ id: userId, name: "Test", email: `${userId}@example.com` });
  });

  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id LIKE 'test-%'");
    await pool.end();
  });

  it("records every listed message, enqueues extraction, and stores counts", async () => {
    const gmail = fakeGmail([["m1", "m2"], ["m3"]]);
    const result = await runGmailBackfill(userId, { db, gmail, enqueueExtract });

    expect(result).toEqual({ listed: 3, newMessages: 3, candidateCount: 3 });
    expect(gmail.queries[0]).toContain("newer_than:365d");
    expect(enqueued.map((j) => j.gmailMessageId).sort()).toEqual(["m1", "m2", "m3"]);

    const [state] = await db.select().from(gmailSyncState).where(eq(gmailSyncState.userId, userId));
    expect(state).toMatchObject({ backfillStatus: "done", candidateCount: 3, historyId: "1000", lastError: null });
    expect(state.lastSyncedAt).toBeInstanceOf(Date);
  });

  it("is idempotent: a re-run adds nothing and keeps the first history ID", async () => {
    await runGmailBackfill(userId, { db, gmail: fakeGmail([["m1", "m2"]], "1000"), enqueueExtract });
    const again = await runGmailBackfill(userId, {
      db,
      gmail: fakeGmail([["m1", "m2", "m4"]], "2000"),
      enqueueExtract,
    });

    expect(again).toEqual({ listed: 3, newMessages: 1, candidateCount: 3 });
    const rows = await db.select().from(processedMessages).where(eq(processedMessages.userId, userId));
    expect(rows).toHaveLength(3);
    const [state] = await db.select().from(gmailSyncState).where(eq(gmailSyncState.userId, userId));
    expect(state.historyId).toBe("1000");
  });

  it("does not re-enqueue messages that were already processed", async () => {
    await runGmailBackfill(userId, { db, gmail: fakeGmail([["m1", "m2"]]), enqueueExtract });
    await db
      .update(processedMessages)
      .set({ status: "extracted" })
      .where(eq(processedMessages.gmailMessageId, "m1"));
    enqueued = [];

    await runGmailBackfill(userId, { db, gmail: fakeGmail([["m1", "m2"]]), enqueueExtract });
    expect(enqueued.map((j) => j.gmailMessageId)).toEqual(["m2"]);
  });

  it("handles an empty mailbox", async () => {
    const result = await runGmailBackfill(userId, { db, gmail: fakeGmail([[]]), enqueueExtract });
    expect(result).toEqual({ listed: 0, newMessages: 0, candidateCount: 0 });
    expect(enqueued).toEqual([]);
  });

  describe("incremental sync", () => {
    it("does nothing until the first full scan has finished", async () => {
      expect(await runGmailSync(userId, { db, gmail: fakeGmail([["m1"]]), enqueueExtract })).toBeNull();
    });

    it("searches the days since the last sync plus a margin, and only queues new mail", async () => {
      await runGmailBackfill(userId, { db, gmail: fakeGmail([["m1", "m2"]]), enqueueExtract });
      await db
        .update(gmailSyncState)
        .set({ lastSyncedAt: new Date("2026-10-10T00:00:00Z") })
        .where(eq(gmailSyncState.userId, userId));
      enqueued = [];

      const gmail = fakeGmail([["m2", "m3"]]);
      const result = await runGmailSync(userId, { db, gmail, enqueueExtract }, new Date("2026-10-15T00:00:00Z"));
      expect(gmail.queries[0]).toMatch(/^newer_than:7d /); // 5 days + 2 margin
      expect(result).toEqual({ listed: 2, newMessages: 1, candidateCount: 3 });
      // m2 is still `queued` (never extracted here), so it is re-enqueued too.
      expect(enqueued.map((j) => j.gmailMessageId)).toEqual(["m2", "m3"]);
    });

    it("skips disconnected accounts", async () => {
      await runGmailBackfill(userId, { db, gmail: fakeGmail([["m1"]]), enqueueExtract });
      await db.update(gmailSyncState).set({ disconnectedAt: new Date() }).where(eq(gmailSyncState.userId, userId));
      expect(await runGmailSync(userId, { db, gmail: fakeGmail([["m9"]]), enqueueExtract })).toBeNull();
    });
  });
});
