import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { db, pool } from "@/db/client";
import { gmailSyncState } from "@/db/schema";
import { env } from "@/env";
import { getGoogleAccessToken, GoogleReconnectRequiredError } from "@/lib/google/auth";
import { createGmailReader } from "@/lib/google/gmail";
import {
  ensureQueues,
  QUEUES,
  type EmailExtractJob,
  type GmailBackfillJob,
  type LedgerMergeJob,
} from "@/lib/jobs/queues";
import { mergeExtraction } from "@/lib/ledger/merge";
import { createLLM } from "@/lib/llm";
import { LLMRateLimitError } from "@/lib/llm/types";
import { runEmailExtract } from "./jobs/email-extract";
import { runGmailBackfill } from "./jobs/gmail-backfill";
import { createPacer } from "./pacer";

async function registerHandlers(boss: PgBoss): Promise<void> {
  const enqueueExtract = async (jobs: EmailExtractJob[]) => {
    await boss.insert(
      QUEUES.emailExtract.name,
      jobs.map((data) => ({ data, singletonKey: `${data.userId}:${data.gmailMessageId}` })),
    );
  };

  await boss.work<GmailBackfillJob>(QUEUES.gmailBackfill.name, async ([job]) => {
    const { userId } = job.data;
    try {
      const accessToken = await getGoogleAccessToken(userId);
      const result = await runGmailBackfill(userId, {
        db,
        gmail: createGmailReader(accessToken),
        enqueueExtract,
      });
      console.log(`[gmail.backfill] user=${userId}`, result);
    } catch (err) {
      const reconnect = err instanceof GoogleReconnectRequiredError;
      await db
        .update(gmailSyncState)
        .set({
          backfillStatus: "failed",
          lastError: reconnect ? err.message : "Gmail scan failed; retrying automatically.",
          ...(reconnect && { disconnectedAt: new Date() }),
        })
        .where(eq(gmailSyncState.userId, userId));
      // Only the message: Google errors can echo request details.
      console.error(`[gmail.backfill] user=${userId} failed:`, err instanceof Error ? err.message : err);
      if (!reconnect) throw err; // let pg-boss retry with backoff
    }
  });

  await boss.work<LedgerMergeJob>(QUEUES.ledgerMerge.name, async ([job]) => {
    const result = await mergeExtraction(db, job.data.extractionId);
    console.log(`[ledger.merge] extraction=${job.data.extractionId} →`, result ?? "skipped");
    // M4: when result.nextChargeChanged, enqueue calendar.upsert + reminders.plan.
  });

  if (!env.GEMINI_API_KEY) {
    console.warn("[worker] GEMINI_API_KEY not set: email.extract jobs will wait in the queue.");
    return;
  }
  const llm = createLLM();
  const pacer = createPacer(env.LLM_MIN_INTERVAL_MS);
  const pausedUsers = new Set<string>();
  const enqueueMerge = async (data: LedgerMergeJob) => {
    await boss.send(QUEUES.ledgerMerge.name, data, { singletonKey: data.extractionId });
  };

  // One at a time: the LLM's rate limit is the bottleneck, not the worker.
  await boss.work<EmailExtractJob>(
    QUEUES.emailExtract.name,
    { batchSize: 1, localConcurrency: 1 },
    async ([job]) => {
      const { userId, gmailMessageId } = job.data;
      try {
        const accessToken = await getGoogleAccessToken(userId);
        const outcome = await runEmailExtract(userId, gmailMessageId, {
          db,
          gmail: createGmailReader(accessToken),
          llm,
          pace: () => pacer.wait(),
          enqueueMerge,
        });
        console.log(`[email.extract] ${gmailMessageId}: ${outcome}`);
        if (pausedUsers.delete(userId)) {
          await db.update(gmailSyncState).set({ extractPausedUntil: null }).where(eq(gmailSyncState.userId, userId));
        }
      } catch (err) {
        if (err instanceof GoogleReconnectRequiredError) {
          // Leave the message `queued`; a scan after reconnecting re-enqueues it.
          console.warn(`[email.extract] user=${userId} needs to reconnect Google; skipping`);
          return;
        }
        if (err instanceof LLMRateLimitError) {
          const seconds = err.retryAfterSeconds ?? 60;
          pacer.pushBack(seconds);
          if (seconds > 120) {
            // Long wait (daily quota): reschedule instead of burning retries or
            // holding the job open, and tell the dashboard when we'll resume.
            const resumeAt = new Date(Date.now() + seconds * 1000);
            await boss.send(QUEUES.emailExtract.name, job.data, {
              singletonKey: `${userId}:${gmailMessageId}`,
              startAfter: resumeAt,
            });
            await db.update(gmailSyncState).set({ extractPausedUntil: resumeAt }).where(eq(gmailSyncState.userId, userId));
            pausedUsers.add(userId);
            console.warn(`[email.extract] LLM quota reached; resuming at ${resumeAt.toISOString()}`);
            return;
          }
          console.warn(`[email.extract] rate limited; pausing ${seconds}s`);
        } else {
          console.error(`[email.extract] ${gmailMessageId} failed:`, err instanceof Error ? err.message : err);
        }
        throw err;
      }
    },
  );
  console.log(`[worker] extracting with ${llm.model}, ≥${env.LLM_MIN_INTERVAL_MS}ms between calls`);
}

async function main(): Promise<void> {
  const boss = new PgBoss({ connectionString: env.DATABASE_URL });
  boss.on("error", (err: Error) => console.error("[worker] pg-boss error:", err.message));

  await boss.start();
  await ensureQueues(boss);
  await registerHandlers(boss);

  console.log("[worker] ready");

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, draining…`);
    await boss.stop({ graceful: true, timeout: 30_000 });
    await pool.end();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[worker] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
