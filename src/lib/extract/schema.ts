import { z } from "zod";
import { isSupportedCurrency } from "@/lib/money";

// ARCHITECTURE §3.3. This is both the JSON schema sent to the model and the
// validator for what comes back.

export const EMAIL_KINDS = [
  "receipt",
  "renewal_notice",
  "trial_started",
  "trial_ending",
  "cancellation_confirmation",
  "price_change",
  "not_subscription",
] as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "must be a real date");

export const extractionSchema = z.object({
  kind: z.enum(EMAIL_KINDS),
  merchant: z.string().min(1).max(100).nullable().describe('Service display name, e.g. "Spotify"'),
  plan: z.string().min(1).max(100).nullable().describe('Plan name, e.g. "Premium Individual"'),
  amount: z.number().nonnegative().max(1_000_000).nullable().describe("Recurring price in major units, e.g. 11.99"),
  // Soft fields: a bad value becomes null instead of failing the whole extraction.
  currency: z
    .string()
    .nullable()
    .transform((s) => (s && isSupportedCurrency(s.toUpperCase()) ? s.toUpperCase() : null))
    .describe("ISO 4217 code, e.g. USD"),
  billing_cycle: z.enum(["weekly", "monthly", "quarterly", "yearly", "other"]).nullable(),
  charge_date: isoDate.nullable().describe("Date of the charge this email confirms"),
  next_charge_date: isoDate.nullable().describe("Next charge/renewal date if stated"),
  trial_end_date: isoDate.nullable().describe("Date the free trial ends if stated"),
  cancel_url: z
    .string()
    .nullable()
    .transform((s) => (s && s.length <= 2000 && /^https:\/\/\S+$/.test(s) ? s : null))
    .describe("Link to cancel or manage the subscription, if present"),
  confidence: z.number().min(0).max(1).describe("0–1: how sure you are this is right"),
});

export type Extraction = z.infer<typeof extractionSchema>;

/** JSON Schema for the model's structured-output mode. */
// `$schema` is dropped: providers' structured-output modes don't accept it.
const jsonSchema: Record<string, unknown> = z.toJSONSchema(extractionSchema, { io: "input" });
delete jsonSchema.$schema;
export const extractionJsonSchema = jsonSchema;
