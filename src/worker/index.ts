import { and, eq, isNull } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { db, pool } from "@/db/client";
import { gmailSyncState, subscriptions } from "@/db/schema";
import { directDatabaseUrl, env } from "@/env";
import { getGoogleAccessToken, GoogleReconnectRequiredError } from "@/lib/google/auth";
import { createGmailReader } from "@/lib/google/gmail";
import {
  enqueueSubscriptionSync,
  ensureQueues,
  QUEUES,
  type EmailExtractJob,
  type GmailBackfillJob,
  type LedgerMergeJob,
  type SubscriptionJob,
} from "@/lib/jobs/queues";
import { CALENDAR_EVENTS } from "@/lib/google/auth";
import { createCalendarClient } from "@/lib/google/calendar";
import { recomputeSubscription } from "@/lib/ledger/merge";
import { recomputePriorities } from "@/lib/priority/recompute";
import { createResendSender } from "@/lib/reminders/email";
import { runCalendarUpsert } from "./jobs/calendar-upsert";
import { runRemindersDispatch, runRemindersPlan, subscriptionsToRefresh } from "./jobs/reminders";
import { mergeExtraction } from "@/lib/ledger/merge";
import { createLLM } from "@/lib/llm";
import { LLMRateLimitError } from "@/lib/llm/types";
import { runEmailExtract } from "./jobs/email-extract";
import { runGmailBackfill, runGmailSync } from "./jobs/gmail-backfill";
import { createPacer } from "./pacer";

async function registerHandlers(boss: PgBoss): Promise<void> {
  const enqueueExtract = async (jobs: EmailExtractJob[]) => {
    await boss.insert(
      QUEUES.emailExtract.name,
      jobs.map((data) => ({ data, singletonKey: `${data.userId}:${data.gmailMessageId}` })),
    );
  };

  // Shared by the full scan and the 4-hourly sync.
  const scanJob = (name: string, run: typeof runGmailBackfill | typeof runGmailSync, failStatus: boolean) =>
    async ([job]: { data: GmailBackfillJob }[]) => {
      const { userId } = job.data;
      try {
        const accessToken = await getGoogleAccessToken(userId);
        const result = await run(userId, { db, gmail: createGmailReader(accessToken), enqueueExtract });
        console.log(`[${name}] user=${userId}`, result ?? "skipped");
      } catch (err) {
        const reconnect = err instanceof GoogleReconnectRequiredError;
        await db
          .update(gmailSyncState)
          .set({
            ...(failStatus && { backfillStatus: "failed" as const }),
            lastError: reconnect ? err.message : "Gmail scan failed; retrying automatically.",
            ...(reconnect && { disconnectedAt: new Date() }),
          })
          .where(eq(gmailSyncState.userId, userId));
        // Only the message: Google errors can echo request details.
        console.error(`[${name}] user=${userId} failed:`, err instanceof Error ? err.message : err);
        if (!reconnect) throw err; // let pg-boss retry with backoff
      }
    };
  await boss.work<GmailBackfillJob>(QUEUES.gmailBackfill.name, scanJob("gmail.backfill", runGmailBackfill, true));
  await boss.work<GmailBackfillJob>(QUEUES.gmailSync.name, scanJob("gmail.sync", runGmailSync, false));

  await boss.work(QUEUES.gmailSyncAll.name, async () => {
    const users = await db
      .select({ userId: gmailSyncState.userId })
      .from(gmailSyncState)
      .where(and(eq(gmailSyncState.backfillStatus, "done"), isNull(gmailSyncState.disconnectedAt)));
    for (const { userId } of users) {
      const data: GmailBackfillJob = { userId };
      await boss.send(QUEUES.gmailSync.name, data, { singletonKey: userId });
    }
    console.log(`[gmail.sync.all] queued ${users.length} users`);
  });
  await boss.schedule(QUEUES.gmailSyncAll.name, "0 */4 * * *");

  await boss.work<LedgerMergeJob>(QUEUES.ledgerMerge.name, async ([job]) => {
    const result = await mergeExtraction(db, job.data.extractionId);
    console.log(`[ledger.merge] extraction=${job.data.extractionId} →`, result ?? "skipped");
    if (result) {
      await recomputePriorities(db, job.data.userId);
      await enqueueSubscriptionSync(boss, result.subscriptionId);
    }
  });

  await boss.work<SubscriptionJob>(QUEUES.remindersPlan.name, async ([job]) => {
    const n = await runRemindersPlan(db, job.data.subscriptionId);
    console.log(`[reminders.plan] subscription=${job.data.subscriptionId}: ${n} upcoming`);
  });

  await boss.work<SubscriptionJob>(QUEUES.calendarUpsert.name, async ([job]) => {
    const { subscriptionId } = job.data;
    const [sub] = await db.select({ userId: subscriptions.userId }).from(subscriptions).where(eq(subscriptions.id, subscriptionId));
    if (!sub) return;
    try {
      const token = await getGoogleAccessToken(sub.userId, [CALENDAR_EVENTS]);
      const outcome = await runCalendarUpsert(db, subscriptionId, createCalendarClient(token));
      console.log(`[calendar.upsert] subscription=${subscriptionId}: ${outcome}`);
    } catch (err) {
      if (err instanceof GoogleReconnectRequiredError) {
        console.warn(`[calendar.upsert] user=${sub.userId}: ${err.message}`);
        return; // no calendar access: email reminders still work
      }
      throw err;
    }
  });

  await boss.work(QUEUES.subscriptionsRefresh.name, async () => {
    const ids = await subscriptionsToRefresh(db);
    for (const id of ids) {
      await recomputeSubscription(db, id);
      await enqueueSubscriptionSync(boss, id);
    }
    // Scores are relative within a user, so recompute per user after the dates moved.
    const owners = await db.selectDistinct({ userId: subscriptions.userId }).from(subscriptions);
    for (const { userId } of owners) await recomputePriorities(db, userId);
    console.log(`[subscriptions.refresh] ${ids.length} subscriptions`);
  });
  await boss.schedule(QUEUES.subscriptionsRefresh.name, "0 6 * * *"); // daily, 06:00 UTC

  if (env.RESEND_API_KEY) {
    const sender = createResendSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM });
    await boss.work(QUEUES.remindersDispatch.name, async () => {
      const r = await runRemindersDispatch(db, sender);
      if (r.sent || r.failed || r.skipped) console.log("[reminders.dispatch]", r);
    });
    await boss.schedule(QUEUES.remindersDispatch.name, "*/15 * * * *");
  } else {
    console.warn("[worker] RESEND_API_KEY not set: reminder emails will wait.");
  }

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
  const boss = new PgBoss({ connectionString: directDatabaseUrl });
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
