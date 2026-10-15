import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { extractions, processedMessages } from "@/db/schema";
import { emailBodyText } from "@/lib/extract/html-to-text";
import { extractEmail, ExtractionInvalidError } from "@/lib/extract/extract";
import { senderDomain, type GmailReader } from "@/lib/google/gmail";
import type { LedgerMergeJob } from "@/lib/jobs/queues";
import type { StructuredLLM } from "@/lib/llm/types";
import { toMinorUnits } from "@/lib/money";

export interface ExtractDeps {
  db: Db;
  gmail: GmailReader;
  llm: StructuredLLM;
  /** Resolves when the next LLM call is allowed (rate limiting). */
  pace: () => Promise<void>;
  enqueueMerge: (job: LedgerMergeJob) => Promise<void>;
}

export type ExtractOutcome = "already_done" | "gone" | "empty" | "extracted" | "invalid";

/**
 * Fetches one email, extracts it with the LLM and stores only the validated
 * fields. Idempotent: does nothing unless processed_messages says `queued`,
 * and the extraction insert is unique per (user, message).
 */
export async function runEmailExtract(
  userId: string,
  gmailMessageId: string,
  deps: ExtractDeps,
): Promise<ExtractOutcome> {
  const { db } = deps;
  const where = and(eq(processedMessages.userId, userId), eq(processedMessages.gmailMessageId, gmailMessageId));

  const [row] = await db.select({ status: processedMessages.status }).from(processedMessages).where(where);
  if (!row || row.status !== "queued") return "already_done";

  const setStatus = (status: "extracted" | "skipped" | "failed") =>
    db.update(processedMessages).set({ status, processedAt: new Date() }).where(where);

  const msg = await deps.gmail.getMessage(gmailMessageId);
  if (!msg) {
    await setStatus("skipped");
    return "gone";
  }
  const body = emailBodyText(msg);
  if (!body && !msg.subject) {
    await setStatus("skipped");
    return "empty";
  }

  await deps.pace();
  let result;
  try {
    result = await extractEmail(deps.llm, { from: msg.from, subject: msg.subject, date: msg.date, body });
  } catch (err) {
    if (err instanceof ExtractionInvalidError) {
      await setStatus("failed");
      return "invalid";
    }
    throw err; // transient (network, rate limit): pg-boss retries
  }
  // `msg` and `body` go out of scope here; only extracted fields are stored.

  const { extraction, model } = result;
  const amountMinor =
    extraction.amount != null && extraction.currency ? toMinorUnits(extraction.amount, extraction.currency) : null;

  const extractionId = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(extractions)
      .values({
        userId,
        gmailMessageId,
        senderDomain: senderDomain(msg.from),
        sentAt: new Date(msg.date),
        kind: extraction.kind,
        payload: { ...extraction, amount_minor: amountMinor },
        confidence: extraction.confidence,
        model,
      })
      .onConflictDoNothing()
      .returning({ id: extractions.id });
    await tx.update(processedMessages).set({ status: "extracted", processedAt: new Date() }).where(where);
    return inserted?.id ?? null;
  });

  if (extractionId && extraction.kind !== "not_subscription") {
    await deps.enqueueMerge({ userId, extractionId });
  }
  return "extracted";
}
