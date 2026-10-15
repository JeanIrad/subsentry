import type { PgBoss } from "pg-boss";

// One entry per job in ARCHITECTURE §6. Handlers live in src/worker/jobs.
export const QUEUES = {
  // stately + singletonKey userId: at most one queued and one running scan per user,
  // so repeated taps on "Scan" don't pile up duplicate scans.
  gmailBackfill: { name: "gmail.backfill", policy: "stately" },
  gmailSync: { name: "gmail.sync", policy: "singleton" },
  // stately + singletonKey `${userId}:${messageId}`: at most one queued job per message,
  // so re-enqueueing during a re-run is a no-op.
  emailExtract: { name: "email.extract", policy: "stately" },
  ledgerMerge: { name: "ledger.merge", policy: "standard" },
  calendarUpsert: { name: "calendar.upsert", policy: "singleton" },
  remindersPlan: { name: "reminders.plan", policy: "standard" },
  remindersDispatch: { name: "reminders.dispatch", policy: "singleton" },
  priorityRecompute: { name: "priority.recompute", policy: "singleton" },
  // Every 4 hours: enqueue gmail.sync for each connected user.
  gmailSyncAll: { name: "gmail.sync.all", policy: "singleton" },
  // Daily: recompute every subscription (dates roll forward) and re-plan.
  subscriptionsRefresh: { name: "subscriptions.refresh", policy: "singleton" },
} as const;

export type GmailBackfillJob = { userId: string };
export type EmailExtractJob = { userId: string; gmailMessageId: string };
export type LedgerMergeJob = { userId: string; extractionId: string };
export type SubscriptionJob = { subscriptionId: string };

/** Re-plan reminders and the calendar event after anything about a subscription changed. */
export async function enqueueSubscriptionSync(boss: PgBoss, subscriptionId: string): Promise<void> {
  const data: SubscriptionJob = { subscriptionId };
  await boss.send(QUEUES.remindersPlan.name, data, { singletonKey: subscriptionId });
  await boss.send(QUEUES.calendarUpsert.name, data, { singletonKey: subscriptionId });
}

export async function ensureQueues(boss: PgBoss): Promise<void> {
  const existing = new Set((await boss.getQueues()).map((q) => q.name));
  for (const { name, policy } of Object.values(QUEUES)) {
    if (existing.has(name)) continue;
    await boss.createQueue(name, {
      policy,
      retryLimit: 5,
      retryBackoff: true,
      retryDelay: 30,
    });
  }
}
