import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { db } from "@/db/client";
import { gmailSyncState, subscriptions } from "@/db/schema";
import { env } from "@/env";
import { CALENDAR_EVENTS, getGoogleAccessToken, GoogleReconnectRequiredError } from "@/lib/google/auth";
import { createCalendarClient } from "@/lib/google/calendar";
import { createGmailReader } from "@/lib/google/gmail";
import {
  enqueueSubscriptionSync,
  QUEUES,
  type EmailExtractJob,
  type GmailBackfillJob,
  type LedgerMergeJob,
  type SubscriptionJob,
} from "@/lib/jobs/queues";
import { mergeExtraction, recomputeSubscription } from "@/lib/ledger/merge";
import { createLLM } from "@/lib/llm";
import { LLMRateLimitError } from "@/lib/llm/types";
import { recomputePriorities } from "@/lib/priority/recompute";
import { createResendSender } from "@/lib/reminders/email";
import { runCalendarUpsert } from "./jobs/calendar-upsert";
import { runEmailExtract } from "./jobs/email-extract";
import { runGmailBackfill, runGmailSync } from "./jobs/gmail-backfill";
import { runRemindersDispatch, runRemindersPlan, subscriptionsToRefresh } from "./jobs/reminders";
import { createPacer, type Pacer } from "./pacer";

// The job handlers, shared by both runners: the long-running worker
// (src/worker/index.ts, local dev / an always-on host) and the time-boxed
// tick (src/worker/tick.ts, Vercel). Each takes one job's data; throwing
// lets pg-boss retry with backoff.

export type JobHandler = (data: unknown) => Promise<void>;

export interface Handlers {
  /** Queue name → handler. Queues whose service isn't configured are absent, so their jobs wait. */
  byQueue: Map<string, JobHandler>;
  /** The LLM pacer, or null when no LLM key is set. */
  pacer: Pacer | null;
}

export interface HandlerOptions {
  /**
   * On an LLM rate limit with a wait longer than this, reschedule the job
   * (and show "resuming at" on the dashboard) instead of throwing for a retry.
   * The worker can sit out short waits; a tick can't.
   */
  rescheduleAfterSeconds: number;
  /** Longest the pacer may sleep before treating the wait as a rate limit. */
  maxPacerSleepMs: number;
}

function typed<T>(fn: (data: T) => Promise<void>): JobHandler {
  // Job payloads are written only by our own enqueue helpers (src/lib/jobs).
  return fn as JobHandler;
}

export function createHandlers(boss: PgBoss, options: HandlerOptions): Handlers {
  const byQueue = new Map<string, JobHandler>();

  const enqueueExtract = async (jobs: EmailExtractJob[]) => {
    await boss.insert(
      QUEUES.emailExtract.name,
      jobs.map((data) => ({ data, singletonKey: `${data.userId}:${data.gmailMessageId}` })),
    );
  };

  // Shared by the full scan and the 4-hourly sync.
  const scanJob = (name: string, run: typeof runGmailBackfill | typeof runGmailSync, failStatus: boolean) =>
    typed<GmailBackfillJob>(async ({ userId }) => {
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
    });
  byQueue.set(QUEUES.gmailBackfill.name, scanJob("gmail.backfill", runGmailBackfill, true));
  byQueue.set(QUEUES.gmailSync.name, scanJob("gmail.sync", runGmailSync, false));

  byQueue.set(QUEUES.gmailSyncAll.name, async () => {
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

  byQueue.set(
    QUEUES.ledgerMerge.name,
    typed<LedgerMergeJob>(async ({ userId, extractionId }) => {
      const result = await mergeExtraction(db, extractionId);
      console.log(`[ledger.merge] extraction=${extractionId} →`, result ?? "skipped");
      if (result) {
        await recomputePriorities(db, userId);
        await enqueueSubscriptionSync(boss, result.subscriptionId);
      }
    }),
  );

  byQueue.set(
    QUEUES.remindersPlan.name,
    typed<SubscriptionJob>(async ({ subscriptionId }) => {
      const n = await runRemindersPlan(db, subscriptionId);
      console.log(`[reminders.plan] subscription=${subscriptionId}: ${n} upcoming`);
    }),
  );

  byQueue.set(
    QUEUES.calendarUpsert.name,
    typed<SubscriptionJob>(async ({ subscriptionId }) => {
      const [sub] = await db
        .select({ userId: subscriptions.userId })
        .from(subscriptions)
        .where(eq(subscriptions.id, subscriptionId));
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
    }),
  );

  byQueue.set(QUEUES.subscriptionsRefresh.name, async () => {
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

  if (env.RESEND_API_KEY) {
    const sender = createResendSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM });
    byQueue.set(QUEUES.remindersDispatch.name, async () => {
      const r = await runRemindersDispatch(db, sender);
      if (r.sent || r.failed || r.skipped) console.log("[reminders.dispatch]", r);
    });
  } else {
    console.warn("[jobs] RESEND_API_KEY not set: reminder emails will wait.");
  }

  if (!env.GEMINI_API_KEY) {
    console.warn("[jobs] GEMINI_API_KEY not set: email.extract jobs will wait in the queue.");
    return { byQueue, pacer: null };
  }

  const llm = createLLM();
  const pacer = createPacer(env.LLM_MIN_INTERVAL_MS, options.maxPacerSleepMs);
  const enqueueMerge = async (data: LedgerMergeJob) => {
    await boss.send(QUEUES.ledgerMerge.name, data, { singletonKey: data.extractionId });
  };

  byQueue.set(
    QUEUES.emailExtract.name,
    typed<EmailExtractJob>(async (data) => {
      const { userId, gmailMessageId } = data;
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
        // Clear a "resuming at" notice from an earlier rate limit (no-op otherwise).
        await db
          .update(gmailSyncState)
          .set({ extractPausedUntil: null })
          .where(and(eq(gmailSyncState.userId, userId), isNotNull(gmailSyncState.extractPausedUntil)));
      } catch (err) {
        if (err instanceof GoogleReconnectRequiredError) {
          // Leave the message `queued`; a scan after reconnecting re-enqueues it.
          console.warn(`[email.extract] user=${userId} needs to reconnect Google; skipping`);
          return;
        }
        if (err instanceof LLMRateLimitError) {
          const seconds = err.retryAfterSeconds ?? 60;
          pacer.pushBack(seconds);
          if (seconds > options.rescheduleAfterSeconds) {
            // Reschedule instead of burning retries or holding the job open,
            // and tell the dashboard when we'll resume.
            const resumeAt = new Date(Date.now() + seconds * 1000);
            await boss.send(QUEUES.emailExtract.name, data, {
              singletonKey: `${userId}:${gmailMessageId}`,
              startAfter: resumeAt,
            });
            await db.update(gmailSyncState).set({ extractPausedUntil: resumeAt }).where(eq(gmailSyncState.userId, userId));
            console.warn(`[email.extract] LLM rate limit; resuming at ${resumeAt.toISOString()}`);
            return;
          }
          console.warn(`[email.extract] rate limited; pausing ${seconds}s`);
        } else {
          console.error(`[email.extract] ${gmailMessageId} failed:`, err instanceof Error ? err.message : err);
        }
        throw err;
      }
    }),
  );
  console.log(`[jobs] extracting with ${llm.model}, ≥${env.LLM_MIN_INTERVAL_MS}ms between calls`);
  return { byQueue, pacer };
}

/** Recurring jobs. The worker registers them as pg-boss crons; the tick enqueues them per time slot. */
export const RECURRING = [
  { queue: QUEUES.remindersDispatch.name, cron: "*/15 * * * *", everySeconds: 15 * 60 },
  { queue: QUEUES.gmailSyncAll.name, cron: "0 */4 * * *", everySeconds: 4 * 3600 },
  // Daily, 06:00 UTC (the tick runs it on its first call after 06:00).
  { queue: QUEUES.subscriptionsRefresh.name, cron: "0 6 * * *", everySeconds: 24 * 3600, notBeforeUtcHour: 6 },
] as const;
