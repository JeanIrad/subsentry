import { KNOWN_SENDERS } from "./known-senders";

// Gmail search pre-filter (SPEC FR-1). Everything that matches becomes an LLM
// call in M2, so precision here is cost.

export const SUBJECT_KEYWORDS: readonly string[] = [
  "receipt",
  "invoice",
  "subscription",
  "\"free trial\"",
  "\"trial ends\"",
  "\"trial ending\"",
  "renewal",
  "renews",
  "\"your plan\"",
  "membership",
  "\"payment confirmation\"",
  "\"payment received\"",
  "billing",
  "canceled",
  "cancelled",
  "\"price change\"",
];

// Required in the body/subject when matching on sender alone, to skip
// "New on Netflix this week"-style marketing.
export const BILLING_TERMS: readonly string[] = [
  "subscription",
  "membership",
  "billing",
  "billed",
  "payment",
  "renew",
  "trial",
  "receipt",
  "invoice",
  "charged",
];

const or = (terms: readonly string[]) => `(${terms.join(" OR ")})`;

export function buildCandidateQuery(opts: { newerThanDays: number }): string {
  const bySubject = `subject:${or(SUBJECT_KEYWORDS)}`;
  const bySender = `(from:${or(KNOWN_SENDERS)} ${or(BILLING_TERMS)})`;
  return [
    `newer_than:${opts.newerThanDays}d`,
    `(${bySubject} OR ${bySender})`,
    "-category:social",
    "-category:forums",
    "-in:chats",
  ].join(" ");
}

export const BACKFILL_DAYS = 365;
