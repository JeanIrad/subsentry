import { and, count, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { gmailSyncState, processedMessages } from "@/db/schema";
import { BACKFILL_DAYS, buildCandidateQuery } from "@/lib/google/backfill-query";
import type { GmailReader } from "@/lib/google/gmail";
import type { EmailExtractJob } from "@/lib/jobs/queues";

export interface BackfillDeps {
  db: Db;
  gmail: GmailReader;
  enqueueExtract: (jobs: EmailExtractJob[]) => Promise<void>;
}

export interface BackfillResult {
  listed: number;
  newMessages: number;
  candidateCount: number;
}

/**
 * Lists candidate emails for the last BACKFILL_DAYS and records each in
 * processed_messages. Idempotent: re-running inserts nothing new, and every
 * still-`queued` message is re-enqueued (the stately queue drops duplicates),
 * which also repairs a crash between insert and enqueue.
 */
export async function runGmailBackfill(userId: string, deps: BackfillDeps): Promise<BackfillResult> {
  const { db, gmail } = deps;

  await db
    .insert(gmailSyncState)
    .values({ userId, backfillStatus: "running" })
    .onConflictDoUpdate({
      target: gmailSyncState.userId,
      set: { backfillStatus: "running", lastError: null },
    });

  // Recorded for future use (Gmail history API); set once, before listing.
  const historyId = await gmail.getHistoryId();
  const [state] = await db
    .select({ historyId: gmailSyncState.historyId })
    .from(gmailSyncState)
    .where(eq(gmailSyncState.userId, userId));
  if (!state?.historyId) {
    await db.update(gmailSyncState).set({ historyId }).where(eq(gmailSyncState.userId, userId));
  }

  const { listed, newMessages } = await collectCandidates(userId, BACKFILL_DAYS, deps);
  const candidateCount = await finishSync(db, userId, { backfillStatus: "done" });
  return { listed, newMessages, candidateCount };
}

/**
 * Incremental sync (every 4 hours): the same search over the days since the
 * last sync plus a margin. Already-seen messages are skipped, so the overlap
 * costs nothing and downtime of any length is covered.
 */
export async function runGmailSync(userId: string, deps: BackfillDeps, now = new Date()): Promise<BackfillResult | null> {
  const [state] = await deps.db.select().from(gmailSyncState).where(eq(gmailSyncState.userId, userId));
  // Nothing to do until the first full scan has finished.
  if (!state || state.backfillStatus !== "done" || state.disconnectedAt) return null;
  const since = state.lastSyncedAt ?? now;
  const days = Math.min(BACKFILL_DAYS, Math.ceil((now.getTime() - since.getTime()) / 86_400_000) + 2);

  const { listed, newMessages } = await collectCandidates(userId, days, deps);
  const candidateCount = await finishSync(deps.db, userId, {});
  return { listed, newMessages, candidateCount };
}

async function collectCandidates(userId: string, days: number, { db, gmail, enqueueExtract }: BackfillDeps) {
  const query = buildCandidateQuery({ newerThanDays: days });
  let pageToken: string | undefined;
  let listed = 0;
  let newMessages = 0;

  do {
    const page = await gmail.listMessageIds(query, pageToken);
    pageToken = page.nextPageToken;
    if (page.ids.length === 0) continue;
    listed += page.ids.length;

    const inserted = await db
      .insert(processedMessages)
      .values(page.ids.map((gmailMessageId) => ({ userId, gmailMessageId })))
      .onConflictDoNothing()
      .returning({ id: processedMessages.gmailMessageId });
    newMessages += inserted.length;

    const queued = await db
      .select({ id: processedMessages.gmailMessageId })
      .from(processedMessages)
      .where(
        and(
          eq(processedMessages.userId, userId),
          eq(processedMessages.status, "queued"),
          inArray(processedMessages.gmailMessageId, page.ids),
        ),
      );
    if (queued.length > 0) {
      await enqueueExtract(queued.map(({ id }) => ({ userId, gmailMessageId: id })));
    }
  } while (pageToken);

  return { listed, newMessages };
}

async function finishSync(db: Db, userId: string, extra: Partial<typeof gmailSyncState.$inferInsert>): Promise<number> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(processedMessages)
    .where(eq(processedMessages.userId, userId));
  await db
    .update(gmailSyncState)
    .set({ ...extra, candidateCount: total, lastSyncedAt: new Date(), lastError: null, disconnectedAt: null })
    .where(eq(gmailSyncState.userId, userId));
  return total;
}
