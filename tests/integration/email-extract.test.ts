import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool } from "@/db/client";
import { extractions, processedMessages, users } from "@/db/schema";
import type { EmailMessage, GmailReader } from "@/lib/google/gmail";
import type { LedgerMergeJob } from "@/lib/jobs/queues";
import type { StructuredLLM } from "@/lib/llm/types";
import { runEmailExtract, type ExtractDeps } from "@/worker/jobs/email-extract";

const BODY_MARKER = "UNIQUE-BODY-TEXT-7f3a";

const message: EmailMessage = {
  id: "msg-1",
  from: "Spotify <no-reply@spotify.com>",
  subject: "Your Spotify Premium receipt",
  date: "2026-09-15T10:00:00.000Z",
  text: `${BODY_MARKER} Premium Individual $11.99 charged Sep 15, 2026. ${"Thanks for listening. ".repeat(10)}`,
  html: null,
};

const receiptJson = JSON.stringify({
  kind: "receipt",
  merchant: "Spotify",
  plan: "Premium Individual",
  amount: 11.99,
  currency: "USD",
  billing_cycle: "monthly",
  charge_date: "2026-09-15",
  next_charge_date: null,
  trial_end_date: null,
  cancel_url: null,
  confidence: 0.93,
});

function deps(llmText: string, msg: EmailMessage | null = message) {
  const merges: LedgerMergeJob[] = [];
  let llmCalls = 0;
  const gmail: GmailReader = {
    getHistoryId: async () => "1",
    listMessageIds: async () => ({ ids: [] }),
    getMessage: async () => msg,
  };
  const llm: StructuredLLM = {
    model: "fake",
    generateJson: async () => {
      llmCalls++;
      return { text: llmText, model: "fake-model-001" };
    },
  };
  const d: ExtractDeps = {
    db,
    gmail,
    llm,
    pace: async () => {},
    enqueueMerge: async (job) => {
      merges.push(job);
    },
  };
  return { d, merges, llmCalls: () => llmCalls };
}

describe("runEmailExtract", () => {
  let userId: string;

  beforeEach(async () => {
    userId = `test-${randomUUID()}`;
    await db.insert(users).values({ id: userId, name: "Test", email: `${userId}@example.com` });
    await db.insert(processedMessages).values({ userId, gmailMessageId: "msg-1" });
  });

  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id LIKE 'test-%'");
    await pool.end();
  });

  const status = async () =>
    (
      await db
        .select({ s: processedMessages.status })
        .from(processedMessages)
        .where(and(eq(processedMessages.userId, userId), eq(processedMessages.gmailMessageId, "msg-1")))
    )[0].s;

  it("stores only extracted fields, converts money, and enqueues a merge", async () => {
    const { d, merges } = deps(receiptJson);
    expect(await runEmailExtract(userId, "msg-1", d)).toBe("extracted");

    const [row] = await db.select().from(extractions).where(eq(extractions.userId, userId));
    expect(row).toMatchObject({ kind: "receipt", senderDomain: "spotify.com", model: "fake-model-001" });
    expect(row.payload).toMatchObject({ merchant: "Spotify", amount: 11.99, amount_minor: 1199, currency: "USD" });
    expect(JSON.stringify(row)).not.toContain(BODY_MARKER);
    expect(await status()).toBe("extracted");
    expect(merges).toEqual([{ userId, extractionId: row.id }]);
  });

  it("is idempotent: a second run does nothing", async () => {
    const first = deps(receiptJson);
    await runEmailExtract(userId, "msg-1", first.d);
    const second = deps(receiptJson);
    expect(await runEmailExtract(userId, "msg-1", second.d)).toBe("already_done");
    expect(second.llmCalls()).toBe(0);
    expect(second.merges).toEqual([]);
    expect(await db.select().from(extractions).where(eq(extractions.userId, userId))).toHaveLength(1);
  });

  it("records non-subscription mail without enqueueing a merge", async () => {
    const { d, merges } = deps(JSON.stringify({ ...JSON.parse(receiptJson), kind: "not_subscription", confidence: 0.9 }));
    await runEmailExtract(userId, "msg-1", d);
    const [row] = await db.select().from(extractions).where(eq(extractions.userId, userId));
    expect(row.kind).toBe("not_subscription");
    expect(row.payload).toMatchObject({ merchant: null, amount_minor: null });
    expect(merges).toEqual([]);
  });

  it("marks the message failed after two invalid model answers", async () => {
    const { d, llmCalls } = deps("garbage");
    expect(await runEmailExtract(userId, "msg-1", d)).toBe("invalid");
    expect(llmCalls()).toBe(2);
    expect(await status()).toBe("failed");
  });

  it("skips messages deleted since the scan", async () => {
    const { d, llmCalls } = deps(receiptJson, null);
    expect(await runEmailExtract(userId, "msg-1", d)).toBe("gone");
    expect(llmCalls()).toBe(0);
    expect(await status()).toBe("skipped");
  });
});
