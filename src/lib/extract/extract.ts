import type { z } from "zod";
import type { StructuredLLM } from "@/lib/llm/types";
import { buildExtractionUserPrompt, EXTRACTION_SYSTEM_PROMPT } from "./prompt";
import { extractionJsonSchema, extractionSchema, type Extraction } from "./schema";

export interface EmailForExtraction {
  from: string;
  subject: string;
  /** ISO 8601 sent time */
  date: string;
  body: string;
}

/** The model returned invalid output twice (SPEC FR-3). Not retryable. */
export class ExtractionInvalidError extends Error {
  constructor(public readonly issues: string) {
    super(`Model output failed validation twice: ${issues}`);
    this.name = "ExtractionInvalidError";
  }
}

export async function extractEmail(
  llm: StructuredLLM,
  email: EmailForExtraction,
): Promise<{ extraction: Extraction; model: string }> {
  const user = buildExtractionUserPrompt({ ...email, date: email.date.slice(0, 10) });

  let issues = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? user
        : `${user}\n\nYour previous answer was invalid (${issues}). Reply again with JSON that matches the schema exactly.`;
    const res = await llm.generateJson({
      system: EXTRACTION_SYSTEM_PROMPT,
      user: prompt,
      jsonSchema: extractionJsonSchema,
    });
    const parsed = parseJson(res.text);
    const result = parsed.ok ? extractionSchema.safeParse(parsed.value) : null;
    if (result?.success) {
      return { extraction: normalize(result.data, email.date), model: res.model };
    }
    // Issue paths/messages only — never the raw text, which echoes email content.
    issues = result ? summarize(result.error) : "response was not valid JSON";
  }
  throw new ExtractionInvalidError(issues);
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    // Some models wrap JSON in ```json fences despite JSON mode.
    return { ok: true, value: JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "")) };
  } catch {
    return { ok: false };
  }
}

function summarize(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/** Deterministic clean-up the model shouldn't be trusted with. */
export function normalize(x: Extraction, sentAt: string): Extraction {
  if (x.kind === "not_subscription") {
    return {
      ...x,
      merchant: null,
      plan: null,
      amount: null,
      currency: null,
      billing_cycle: null,
      charge_date: null,
      next_charge_date: null,
      trial_end_date: null,
      cancel_url: null,
    };
  }
  // Dates far from the email's sent date are almost always misreads.
  const sent = Date.parse(sentAt);
  const plausible = (d: string | null) => {
    if (!d) return null;
    const days = (Date.parse(`${d}T00:00:00Z`) - sent) / 86_400_000;
    return days > -400 && days < 800 ? d : null;
  };
  return {
    ...x,
    merchant: x.merchant?.trim() || null,
    plan: x.plan?.trim() || null,
    // An amount without a currency can't be stored safely.
    amount: x.currency ? x.amount : null,
    charge_date: plausible(x.charge_date),
    next_charge_date: plausible(x.next_charge_date),
    trial_end_date: plausible(x.trial_end_date),
  };
}
