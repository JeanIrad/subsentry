import { Client } from "pg";
import { directDatabaseUrl } from "@/env";
import { getBoss } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { createHandlers, RECURRING, type JobHandler } from "./handlers";

// Serverless job runner: one call drains the queues for up to `budgetMs`, then
// returns. Called by an external scheduler every few minutes (/api/jobs/tick)
// and right after the app enqueues work (src/lib/jobs/kick.ts). Every job is
// idempotent, so a tick cut off mid-job is safe: pg-boss expires the active
// job and retries it.

/** Cheap jobs first so merges, reminders and calendar events aren't stuck behind a long extraction queue. */
const ORDER = [
  QUEUES.remindersDispatch.name,
  QUEUES.ledgerMerge.name,
  QUEUES.remindersPlan.name,
  QUEUES.calendarUpsert.name,
  QUEUES.gmailBackfill.name,
  QUEUES.gmailSync.name,
  QUEUES.gmailSyncAll.name,
  QUEUES.subscriptionsRefresh.name,
  QUEUES.emailExtract.name,
];

/** Leave room for one Gmail fetch + one LLM call before the deadline. */
const EXTRACT_RESERVE_MS = 45_000;
/** Leave room for any other job (Gmail listing, calendar writes). */
const JOB_RESERVE_MS = 20_000;
/** Arbitrary constant naming the advisory lock: only one tick runs at a time. */
const TICK_LOCK_KEY = 7_412_026;

export type TickResult =
  | { status: "busy" }
  | { status: "done"; ran: Record<string, number>; failed: number; ms: number };

export async function runTick({ budgetMs }: { budgetMs: number }): Promise<TickResult> {
  const started = Date.now();
  const deadline = started + budgetMs;

  // Session-level advisory lock on its own connection: released on unlock,
  // or automatically if this function is killed and the connection drops.
  const lock = new Client({ connectionString: directDatabaseUrl });
  await lock.connect();
  try {
    const { rows } = await lock.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [TICK_LOCK_KEY]);
    if (!rows[0]?.ok) return { status: "busy" };

    const boss = await getBoss();
    // Maintenance the worker's supervisor would do: expire stuck jobs, apply retention.
    await boss.supervise();

    const now = new Date();
    for (const r of RECURRING) {
      if ("notBeforeUtcHour" in r && now.getUTCHours() < r.notBeforeUtcHour) continue;
      // One job per time slot, however many ticks run in it.
      await boss.send(r.queue, {}, { singletonSeconds: r.everySeconds });
    }

    const remaining = Math.max(0, deadline - Date.now());
    const { byQueue, pacer } = createHandlers(boss, {
      // A tick can't sit out a rate-limit wait: reschedule every time.
      rescheduleAfterSeconds: 0,
      maxPacerSleepMs: Math.min(30_000, remaining),
    });

    const ran: Record<string, number> = {};
    let failed = 0;
    for (;;) {
      const left = deadline - Date.now();
      if (left < JOB_RESERVE_MS) break;

      let job: { queue: string; id: string; data: unknown; handler: JobHandler } | null = null;
      for (const queue of ORDER) {
        const handler = byQueue.get(queue);
        if (!handler) continue;
        if (queue === QUEUES.emailExtract.name) {
          if (left < EXTRACT_RESERVE_MS) continue;
          // Rate-limited until after this tick ends: leave the jobs for the next one.
          if (pacer && pacer.readyInMs() > left - EXTRACT_RESERVE_MS) continue;
        }
        const [next] = await boss.fetch(queue, { batchSize: 1 });
        if (next) {
          job = { queue, id: next.id, data: next.data, handler };
          break;
        }
      }
      if (!job) break; // every queue is empty (or waiting)

      try {
        await job.handler(job.data);
        await boss.complete(job.queue, job.id);
        ran[job.queue] = (ran[job.queue] ?? 0) + 1;
      } catch (err) {
        failed++;
        // Only the message: errors from Google or the LLM can echo request details.
        await boss.fail(job.queue, job.id, { message: err instanceof Error ? err.message : "failed" });
      }
    }
    return { status: "done", ran, failed, ms: Date.now() - started };
  } finally {
    await lock.query("select pg_advisory_unlock($1)", [TICK_LOCK_KEY]).catch(() => undefined);
    await lock.end().catch(() => undefined);
  }
}
