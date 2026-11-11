import { timingSafeEqual } from "node:crypto";
import { env } from "@/env";
import { runTick } from "@/worker/tick";

// Serverless job runner (JOB_RUNNER=tick). Called every few minutes by an
// external scheduler, and daily by Vercel Cron as a fallback (vercel.json),
// both with `Authorization: Bearer $CRON_SECRET`.

export const maxDuration = 300; // Vercel Hobby maximum
const BUDGET_MS = 270_000;

function authorized(request: Request): boolean {
  if (!env.CRON_SECRET) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${env.CRON_SECRET}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function handle(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  // Counts only: job results never include email content.
  const result = await runTick({ budgetMs: BUDGET_MS });
  return Response.json(result);
}

export const GET = handle;
export const POST = handle;
