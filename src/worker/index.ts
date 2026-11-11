import { PgBoss } from "pg-boss";
import { pool } from "@/db/client";
import { directDatabaseUrl } from "@/env";
import { ensureQueues, QUEUES } from "@/lib/jobs/queues";
import { createHandlers, RECURRING } from "./handlers";

// Long-running worker: local dev (`npm run worker`) or an always-on host.
// On Vercel the same handlers run from /api/jobs/tick instead (src/worker/tick.ts).

async function main(): Promise<void> {
  const boss = new PgBoss({ connectionString: directDatabaseUrl });
  boss.on("error", (err: Error) => console.error("[worker] pg-boss error:", err.message));

  await boss.start();
  await ensureQueues(boss);

  const { byQueue } = createHandlers(boss, { rescheduleAfterSeconds: 120, maxPacerSleepMs: 120_000 });
  for (const [name, handler] of byQueue) {
    // One extraction at a time: the LLM's rate limit is the bottleneck, not the worker.
    const options = name === QUEUES.emailExtract.name ? { batchSize: 1, localConcurrency: 1 } : { batchSize: 1 };
    await boss.work(name, options, async ([job]) => handler(job.data));
  }
  for (const { queue, cron } of RECURRING) if (byQueue.has(queue)) await boss.schedule(queue, cron);

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
