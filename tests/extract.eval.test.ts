import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractEmail } from "@/lib/extract/extract";
import type { Extraction } from "@/lib/extract/schema";
import { createLLM } from "@/lib/llm";
import { LLMRateLimitError } from "@/lib/llm/types";

// Live eval against the configured LLM (SPEC §10). Run: RUN_EVALS=1 npm run eval
// Fixtures are synthetic emails modelled on real formats — never real user mail.

interface Fixture {
  id: string;
  from: string;
  subject: string;
  date: string;
  body: string;
  expected: {
    kind: Extraction["kind"];
    merchant?: string | string[];
    amount?: number;
    currency?: string;
    next_charge_date?: string;
    trial_end_date?: string;
  };
}

// SPEC §11/§7: ≥ 90% from M6 on (M2 required 85%).
const MIN_ACCURACY = Number(process.env.EVAL_MIN_ACCURACY ?? 0.9);
const MIN_PRECISION = 0.9;

const dir = join(import.meta.dirname, "fixtures/emails");
const fixtures: Fixture[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Fixture[])
  .filter((f) => !process.env.EVAL_ONLY || f.id.includes(process.env.EVAL_ONLY));

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9+]/g, "");

/** Field-level mismatches, empty when the extraction is right. */
export function diff(expected: Fixture["expected"], got: Extraction): string[] {
  const out: string[] = [];
  if (got.kind !== expected.kind) out.push(`kind: want ${expected.kind}, got ${got.kind}`);
  if (expected.merchant !== undefined) {
    const wants = [expected.merchant].flat();
    const g = norm(got.merchant ?? "");
    // Containment both ways: "Microsoft 365 Family" ≈ "Microsoft 365".
    if (!g || !wants.some((w) => g.includes(norm(w)) || norm(w).includes(g))) {
      out.push(`merchant: want ${wants.join("|")}, got ${got.merchant}`);
    }
  }
  if (expected.amount !== undefined && (got.amount == null || Math.abs(got.amount - expected.amount) > 0.005)) {
    out.push(`amount: want ${expected.amount}, got ${got.amount}`);
  }
  if (expected.currency !== undefined && got.currency !== expected.currency) {
    out.push(`currency: want ${expected.currency}, got ${got.currency}`);
  }
  for (const k of ["next_charge_date", "trial_end_date"] as const) {
    if (expected[k] !== undefined && got[k] !== expected[k]) out.push(`${k}: want ${expected[k]}, got ${got[k]}`);
  }
  return out;
}

describe.runIf(process.env.RUN_EVALS === "1")("extraction eval", () => {
  it(`scores ≥ ${MIN_ACCURACY * 100}% on ${fixtures.length} fixtures`, async () => {
    const llm = createLLM();
    const minGap = Number(process.env.LLM_MIN_INTERVAL_MS ?? 6000);
    const results: { id: string; want: string; got: string; errors: string[] }[] = [];

    for (const [i, f] of fixtures.entries()) {
      if (i > 0) await sleep(minGap);
      let extraction: Extraction | null = null;
      let error = "";
      for (let attempt = 0; attempt < 8 && !extraction; attempt++) {
        try {
          extraction = (await extractEmail(llm, f)).extraction;
        } catch (err) {
          if (err instanceof LLMRateLimitError) {
            const wait = err.retryAfterSeconds ?? 60;
            if (wait > 120) {
              throw new Error(
                `LLM quota exhausted after ${i} fixtures (retry in ${Math.round(wait / 60)} min). ` +
                  "Free tiers have small daily caps: try another EXTRACT_MODEL or run later.",
              );
            }
            await sleep(wait * 1000);
            continue;
          }
          error = err instanceof Error ? err.message : String(err);
          break;
        }
      }
      const errors = extraction ? diff(f.expected, extraction) : [`error: ${error || "rate limited"}`];
      results.push({ id: f.id, want: f.expected.kind, got: extraction?.kind ?? "error", errors });
      process.stdout.write(errors.length ? "✗" : "·");
    }
    process.stdout.write("\n");

    const correct = results.filter((r) => r.errors.length === 0).length;
    const isSub = (k: string) => k !== "not_subscription" && k !== "error";
    const tp = results.filter((r) => isSub(r.want) && isSub(r.got)).length;
    const fp = results.filter((r) => !isSub(r.want) && isSub(r.got)).length;
    const fn = results.filter((r) => isSub(r.want) && !isSub(r.got)).length;
    const accuracy = correct / results.length;
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);

    // stdout directly: vitest hides console.log from passing tests.
    const report = [
      `Model: ${llm.model}`,
      `Fully correct: ${correct}/${results.length} (${(accuracy * 100).toFixed(1)}%)`,
      `Subscription detection: precision ${(precision * 100).toFixed(1)}%, recall ${(recall * 100).toFixed(1)}%`,
      ...results.filter((r) => r.errors.length).map((r) => `  ✗ ${r.id}: ${r.errors.join("; ")}`),
    ];
    process.stdout.write(`\n${report.join("\n")}\n`);

    expect(precision).toBeGreaterThanOrEqual(MIN_PRECISION);
    expect(accuracy).toBeGreaterThanOrEqual(MIN_ACCURACY);
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
