import { after } from "next/server";
import { env } from "@/env";

/** Serverless budget for a kicked tick, under Vercel Hobby's 300 s function limit. */
const KICK_BUDGET_MS = 240_000;

/**
 * With JOB_RUNNER=tick, start draining the queues once the current response is
 * sent, so a scan or an edit doesn't wait for the next scheduled tick. With the
 * long-running worker this is a no-op. Never throws: the scheduled tick is the
 * safety net.
 */
export function kickJobs(): void {
  if (env.JOB_RUNNER !== "tick") return;
  try {
    after(async () => {
      try {
        const { runTick } = await import("@/worker/tick");
        const result = await runTick({ budgetMs: KICK_BUDGET_MS });
        console.log("[jobs] kicked tick:", result);
      } catch (err) {
        console.error("[jobs] kicked tick failed:", err instanceof Error ? err.message : err);
      }
    });
  } catch {
    // Outside a request (scripts, tests): the scheduled tick will pick the jobs up.
  }
}
