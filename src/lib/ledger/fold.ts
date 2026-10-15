import { addCycles, daysBetween, nextChargeFrom, type Cycle } from "./dates";

// Rebuilds a subscription's state from all of its events, oldest email first.
// Pure and order-independent: merges can arrive in any order and re-running
// gives the same answer (ARCHITECTURE §3.4).

export type EventKind =
  | "receipt"
  | "renewal_notice"
  | "trial_started"
  | "trial_ending"
  | "cancellation_confirmation"
  | "price_change";

export interface LedgerEvent {
  kind: EventKind;
  sentAt: Date;
  confidence: number;
  merchant: string | null;
  plan: string | null;
  amountMinor: number | null;
  currency: string | null;
  billingCycle: Cycle | null;
  chargeDate: string | null;
  nextChargeDate: string | null;
  trialEndDate: string | null;
  cancelUrl: string | null;
}

export type Status = "trial" | "active" | "canceled" | "unknown";

export interface SubscriptionState {
  merchantName: string | null;
  planName: string | null;
  status: Status;
  amountMinor: number | null;
  currency: string | null;
  billingCycle: Cycle | null;
  lastChargeDate: string | null;
  nextChargeDate: string | null;
  trialEndDate: string | null;
  priceChangedAt: Date | null;
  cancelUrl: string | null;
  needsReview: boolean;
  /** Why needsReview is set, for the UI. */
  reviewReason: "low_confidence" | "trial_outcome_unknown" | "stale" | null;
}

export const LOW_CONFIDENCE = 0.6;

/** Days without any email after which a recurring charge is probably gone. */
const STALE_AFTER_DAYS: Record<Cycle, number> = { weekly: 21, monthly: 70, quarterly: 200, yearly: 430, other: 430 };

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function foldEvents(events: LedgerEvent[], today: string): SubscriptionState {
  const s: SubscriptionState = {
    merchantName: null,
    planName: null,
    status: "unknown",
    amountMinor: null,
    currency: null,
    billingCycle: null,
    lastChargeDate: null,
    nextChargeDate: null,
    trialEndDate: null,
    priceChangedAt: null,
    cancelUrl: null,
    needsReview: false,
    reviewReason: null,
  };
  const sorted = [...events].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());

  const setPrice = (e: LedgerEvent) => {
    if (e.amountMinor != null && e.currency) {
      s.amountMinor = e.amountMinor;
      s.currency = e.currency;
    }
  };

  for (const e of sorted) {
    s.merchantName = e.merchant ?? s.merchantName;
    s.planName = e.plan ?? s.planName;
    s.billingCycle = e.billingCycle ?? s.billingCycle;
    s.cancelUrl = e.cancelUrl ?? s.cancelUrl;

    switch (e.kind) {
      case "receipt":
        s.status = "active";
        setPrice(e);
        s.lastChargeDate = e.chargeDate ?? isoDay(e.sentAt);
        s.nextChargeDate = e.nextChargeDate; // recomputed below if missing
        s.trialEndDate = null;
        break;
      case "renewal_notice":
        s.status = "active";
        setPrice(e);
        s.nextChargeDate = e.nextChargeDate ?? s.nextChargeDate;
        break;
      case "trial_started":
      case "trial_ending":
        s.status = "trial";
        setPrice(e);
        s.trialEndDate = e.trialEndDate ?? s.trialEndDate;
        s.nextChargeDate = s.trialEndDate;
        break;
      case "cancellation_confirmation":
        s.status = "canceled";
        s.nextChargeDate = null;
        break;
      case "price_change":
        setPrice(e);
        s.priceChangedAt = e.sentAt;
        break;
    }
  }

  const lastEvent = sorted.at(-1);
  if (sorted.length > 0 && Math.max(...sorted.map((e) => e.confidence)) < LOW_CONFIDENCE) {
    flag(s, "low_confidence");
  }

  if (s.status === "trial" && s.trialEndDate && s.trialEndDate < today) {
    // Trial ended and no receipt or cancellation followed: we can't tell.
    s.status = "unknown";
    s.nextChargeDate = s.billingCycle ? nextChargeFrom(s.trialEndDate, s.billingCycle, today) : null;
    flag(s, "trial_outcome_unknown");
  } else if (s.status === "active") {
    if (!s.nextChargeDate || s.nextChargeDate < today) {
      const anchor = [s.lastChargeDate, s.nextChargeDate].filter((d): d is string => !!d).sort().at(-1);
      s.nextChargeDate = anchor && s.billingCycle ? nextChargeFrom(anchor, s.billingCycle, today) : null;
    }
    // No email for well over a cycle: probably cancelled without a confirmation.
    if (lastEvent && s.billingCycle && daysBetween(isoDay(lastEvent.sentAt), today) > STALE_AFTER_DAYS[s.billingCycle]) {
      const expected = s.lastChargeDate ? addCycles(s.lastChargeDate, s.billingCycle, 1) : null;
      if (!expected || expected < today) {
        s.status = "unknown";
        flag(s, "stale");
      }
    }
  }
  return s;
}

function flag(s: SubscriptionState, reason: NonNullable<SubscriptionState["reviewReason"]>) {
  s.needsReview = true;
  s.reviewReason ??= reason;
}
