import { monthlyEquivalent, type Cycle } from "@/lib/ledger/dates";

// Priority score 0–100 (SPEC §6.4, ARCHITECTURE §3.8): how much this
// subscription seems worth keeping. Low = worth a second look. Each component
// is stored in priority_factors so the UI can explain the number.
//
// Usage signals ("activity emails") are optional in the spec and not
// collected yet; the formula leaves room for them.

export type ReviewAnswer = "keep" | "cancel" | "not_sure";

export interface PriorityInput {
  id: string;
  status: "trial" | "active" | "canceled" | "unknown";
  dismissed: boolean;
  category: string | null;
  amountMinor: number | null;
  currency: string | null;
  billingCycle: Cycle | null;
  reviewAnswer: ReviewAnswer | null;
}

export interface PriorityFactors {
  base: number;
  /** keep +35 · cancel −40 · not sure 0 */
  review: number;
  /** −10 × (cost percentile − 0.5) among the user's subscriptions in the same currency */
  cost: number;
  /** −10 when 3+ live subscriptions share this category */
  overlap: number;
  /** context for explanations, not part of the sum */
  overlapCount?: number;
  costPercentile?: number;
}

export interface PriorityResult {
  score: number;
  factors: PriorityFactors;
}

const REVIEW_POINTS: Record<ReviewAnswer, number> = { keep: 35, cancel: -40, not_sure: 0 };

const live = (s: PriorityInput) => !s.dismissed && (s.status === "active" || s.status === "trial");

/** Scores every live subscription of one user (scores are relative to each other). */
export function computePriorities(subs: PriorityInput[]): Map<string, PriorityResult> {
  const out = new Map<string, PriorityResult>();
  const liveSubs = subs.filter(live);

  for (const s of liveSubs) {
    // Unconfirmed trials start at "Not sure".
    const answer = s.reviewAnswer ?? (s.status === "trial" ? "not_sure" : null);
    const review = answer ? REVIEW_POINTS[answer] : 0;

    let cost = 0;
    let costPercentile: number | undefined;
    const mine = monthly(s);
    const peers = liveSubs.filter((p) => p.currency === s.currency).map(monthly).filter((m): m is number => m != null);
    if (mine != null && peers.length >= 2) {
      // Share of peers strictly cheaper, ties counted half: 0 = cheapest, 1 = priciest.
      const below = peers.filter((p) => p < mine).length;
      const equal = peers.filter((p) => p === mine).length - 1;
      costPercentile = (below + equal / 2) / (peers.length - 1);
      cost = Math.round(-10 * (costPercentile - 0.5));
    }

    const category = s.category && s.category !== "other" ? s.category : null;
    const overlapCount = category ? liveSubs.filter((p) => p.category === category).length : 0;
    const overlap = overlapCount >= 3 ? -10 : 0;

    const factors: PriorityFactors = { base: 50, review, cost, overlap, overlapCount, costPercentile };
    out.set(s.id, { score: clamp(50 + review + cost + overlap), factors });
  }
  return out;
}

function monthly(s: PriorityInput): number | null {
  return s.amountMinor != null && s.currency ? monthlyEquivalent(s.amountMinor, s.billingCycle) : null;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export type PriorityLevel = "high" | "medium" | "low";
export function priorityLevel(score: number): PriorityLevel {
  return score >= 65 ? "high" : score >= 40 ? "medium" : "low";
}

/** Short human reasons, most important first. */
export function explainPriority(f: PriorityFactors, category: string | null, answer: ReviewAnswer | null): string[] {
  const reasons: string[] = [];
  if (answer === "keep") reasons.push("You said you want to keep it");
  else if (answer === "cancel") reasons.push("You said you plan to cancel");
  if (f.overlap < 0 && category) reasons.push(`One of ${f.overlapCount} ${category} subscriptions`);
  if (f.costPercentile != null && f.costPercentile >= 0.75) reasons.push("Among your most expensive");
  else if (f.costPercentile != null && f.costPercentile <= 0.25) reasons.push("Among your cheapest");
  // Least informative, so last: emails show only the first reason.
  if (answer !== "keep" && answer !== "cancel") reasons.push("You haven't decided yet");
  return reasons;
}
