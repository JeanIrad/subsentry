import { PgBoss } from "pg-boss";
import { directDatabaseUrl } from "@/env";
import { enqueueSubscriptionSync, ensureQueues, QUEUES, type GmailBackfillJob } from "./queues";

// Send-only pg-boss client for the Next.js app. The worker runs its own
// full instance (maintenance, schedules, handlers).
const globalForBoss = globalThis as unknown as { bossPromise?: Promise<PgBoss> };

async function startProducer(): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: directDatabaseUrl,
    max: 3,
    supervise: false,
    schedule: false,
  });
  boss.on("error", (err: Error) => console.error("[jobs] pg-boss error:", err.message));
  await boss.start();
  await ensureQueues(boss);
  return boss;
}

export function getBoss(): Promise<PgBoss> {
  globalForBoss.bossPromise ??= startProducer().catch((err: unknown) => {
    globalForBoss.bossPromise = undefined;
    throw err;
  });
  return globalForBoss.bossPromise;
}

/** Idempotent: the singleton queue keyed by user drops duplicates while one is queued. */
export async function enqueueBackfill(userId: string): Promise<void> {
  const boss = await getBoss();
  const data: GmailBackfillJob = { userId };
  await boss.send(QUEUES.gmailBackfill.name, data, { singletonKey: userId });
}

export async function syncSubscription(subscriptionId: string): Promise<void> {
  await enqueueSubscriptionSync(await getBoss(), subscriptionId);
}
