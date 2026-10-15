import type { PgBoss } from "pg-boss";

// One entry per job in ARCHITECTURE §6. Handlers live in src/worker/jobs.
export const QUEUES = {
  gmailBackfill: { name: "gmail.backfill", policy: "singleton" }, // singletonKey = userId
  gmailSync: { name: "gmail.sync", policy: "singleton" },
  // stately + singletonKey `${userId}:${messageId}`: at most one queued job per message,
  // so re-enqueueing during a re-run is a no-op.
  emailExtract: { name: "email.extract", policy: "stately" },
  ledgerMerge: { name: "ledger.merge", policy: "standard" },
  calendarUpsert: { name: "calendar.upsert", policy: "singleton" },
  remindersPlan: { name: "reminders.plan", policy: "standard" },
  remindersDispatch: { name: "reminders.dispatch", policy: "singleton" },
  priorityRecompute: { name: "priority.recompute", policy: "singleton" },
} as const;

export type GmailBackfillJob = { userId: string };
export type EmailExtractJob = { userId: string; gmailMessageId: string };
export type LedgerMergeJob = { userId: string; extractionId: string };

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
