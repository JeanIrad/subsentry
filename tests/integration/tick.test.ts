import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@/db/client";
import { directDatabaseUrl } from "@/env";
import { getBoss } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { runTick } from "@/worker/tick";

async function jobCount(queue: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>("select count(*) as n from pgboss.job where name = $1", [queue]);
  return Number(rows[0]?.n ?? 0);
}

describe("serverless tick", () => {
  beforeEach(async () => {
    await getBoss(); // creates the pg-boss schema and queues
    await pool.query("delete from pgboss.job");
  });

  afterAll(async () => {
    await (await getBoss()).stop({ graceful: false });
    await pool.end();
  });

  it("drains queued jobs and completes them", async () => {
    const boss = await getBoss();
    // Unknown extraction: the merge handler skips it, which still completes the job.
    await boss.send(QUEUES.ledgerMerge.name, {
      userId: "nobody",
      extractionId: "00000000-0000-0000-0000-000000000000",
    });

    const result = await runTick({ budgetMs: 60_000 });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.ran[QUEUES.ledgerMerge.name]).toBe(1);
    expect(result.failed).toBe(0);
    const { rows } = await pool.query<{ state: string }>("select state from pgboss.job where name = $1", [
      QUEUES.ledgerMerge.name,
    ]);
    expect(rows.map((r) => r.state)).toEqual(["completed"]);
  });

  it("enqueues each recurring job once per time slot, however many ticks run", async () => {
    await runTick({ budgetMs: 60_000 });
    await runTick({ budgetMs: 60_000 });
    expect(await jobCount(QUEUES.gmailSyncAll.name)).toBe(1);
  });

  it("skips when another tick holds the lock", async () => {
    const other = new Client({ connectionString: directDatabaseUrl });
    await other.connect();
    try {
      await other.query("select pg_advisory_lock(7412026)");
      expect(await runTick({ budgetMs: 60_000 })).toEqual({ status: "busy" });
    } finally {
      await other.end(); // closing the session releases the lock
    }
  });
});

describe("/api/jobs/tick auth", () => {
  it("rejects requests without the cron secret", async () => {
    const { GET } = await import("@/app/api/jobs/tick/route");
    const res = await GET(new Request("http://localhost/api/jobs/tick"));
    expect(res.status).toBe(401);
    const wrong = await GET(
      new Request("http://localhost/api/jobs/tick", { headers: { authorization: "Bearer nope" } }),
    );
    expect(wrong.status).toBe(401);
  });
});
