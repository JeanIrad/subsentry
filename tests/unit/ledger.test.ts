import { describe, expect, it } from "vitest";
import { addCycles, monthlyEquivalent, nextChargeFrom, todayIn } from "@/lib/ledger/dates";
import { foldEvents, type LedgerEvent } from "@/lib/ledger/fold";
import { merchantKey } from "@/lib/ledger/normalize";

describe("merchantKey", () => {
  it.each([
    ["Spotify", "spotify"],
    ["SPOTIFY AB", "spotify"],
    ["Spotify Premium", "spotify"],
    ["Netflix, Inc.", "netflix"],
    ["netflix.com", "netflix"],
    ["HBO Max", "max"],
    ["Disney Plus", "disney+"],
    ["Disney+", "disney+"],
    ["The New York Times", "the new york times"],
    ["Café Ltd", "cafe"],
    ["1Password Families", "1password"],
  ])("%s → %s", (input, key) => {
    expect(merchantKey(input)).toBe(key);
  });
});

describe("dates", () => {
  it("adds cycles from the anchor without month-end drift", () => {
    expect(addCycles("2026-01-31", "monthly", 1)).toBe("2026-02-28");
    expect(addCycles("2026-01-31", "monthly", 2)).toBe("2026-03-31");
    expect(addCycles("2024-02-29", "yearly", 1)).toBe("2025-02-28");
    expect(addCycles("2026-01-01", "weekly", 2)).toBe("2026-01-15");
    expect(addCycles("2026-01-01", "other", 1)).toBeNull();
  });

  it("rolls forward to the first charge on or after today", () => {
    expect(nextChargeFrom("2026-01-15", "monthly", "2026-04-10")).toBe("2026-04-15");
    expect(nextChargeFrom("2026-01-15", "monthly", "2026-04-15")).toBe("2026-04-15");
    expect(nextChargeFrom("2025-06-01", "yearly", "2026-03-01")).toBe("2026-06-01");
  });

  it("computes today in the user's timezone", () => {
    const now = new Date("2026-10-15T02:30:00Z");
    expect(todayIn("UTC", now)).toBe("2026-10-15");
    expect(todayIn("America/New_York", now)).toBe("2026-10-14");
    expect(todayIn("Asia/Tokyo", now)).toBe("2026-10-15");
  });

  it("converts to monthly equivalents in minor units", () => {
    expect(monthlyEquivalent(13900, "yearly")).toBe(1158);
    expect(monthlyEquivalent(1199, "monthly")).toBe(1199);
    expect(monthlyEquivalent(300, "weekly")).toBe(1300);
    expect(monthlyEquivalent(3000, "quarterly")).toBe(1000);
    expect(monthlyEquivalent(500, "other")).toBeNull();
  });
});

const ev = (e: Partial<LedgerEvent> & Pick<LedgerEvent, "kind" | "sentAt">): LedgerEvent => ({
  confidence: 0.9,
  merchant: "Spotify",
  plan: null,
  amountMinor: null,
  currency: null,
  billingCycle: null,
  chargeDate: null,
  nextChargeDate: null,
  trialEndDate: null,
  cancelUrl: null,
  ...e,
});
const at = (d: string) => new Date(`${d}T12:00:00Z`);

describe("foldEvents", () => {
  const TODAY = "2026-10-15";

  it("projects the next charge from the last receipt and cycle", () => {
    const s = foldEvents(
      [
        ev({ kind: "receipt", sentAt: at("2026-08-04"), amountMinor: 1199, currency: "USD", billingCycle: "monthly", chargeDate: "2026-08-04" }),
        ev({ kind: "receipt", sentAt: at("2026-10-04"), amountMinor: 1199, currency: "USD", chargeDate: "2026-10-04" }),
      ],
      TODAY,
    );
    expect(s).toMatchObject({ status: "active", amountMinor: 1199, lastChargeDate: "2026-10-04", nextChargeDate: "2026-11-04", needsReview: false });
  });

  it("is order-independent", () => {
    const a = ev({ kind: "trial_started", sentAt: at("2026-09-01"), trialEndDate: "2026-10-01", amountMinor: 999, currency: "USD", billingCycle: "monthly" });
    const b = ev({ kind: "receipt", sentAt: at("2026-10-01"), amountMinor: 999, currency: "USD", chargeDate: "2026-10-01" });
    const c = ev({ kind: "cancellation_confirmation", sentAt: at("2026-10-10") });
    expect(foldEvents([c, a, b], TODAY)).toEqual(foldEvents([a, b, c], TODAY));
    expect(foldEvents([c, b, a], TODAY).status).toBe("canceled");
  });

  it("treats an upcoming trial end as the next charge", () => {
    const s = foldEvents(
      [ev({ kind: "trial_started", sentAt: at("2026-10-01"), trialEndDate: "2026-10-31", amountMinor: 999, currency: "USD" })],
      TODAY,
    );
    expect(s).toMatchObject({ status: "trial", trialEndDate: "2026-10-31", nextChargeDate: "2026-10-31", amountMinor: 999 });
  });

  it("asks for review when a trial ended with no follow-up email", () => {
    const s = foldEvents(
      [ev({ kind: "trial_started", sentAt: at("2026-08-01"), trialEndDate: "2026-08-31", billingCycle: "monthly" })],
      TODAY,
    );
    expect(s).toMatchObject({ status: "unknown", needsReview: true, reviewReason: "trial_outcome_unknown", nextChargeDate: "2026-10-31" });
  });

  it("clears the next charge on cancellation, and a later receipt reactivates", () => {
    const cancel = ev({ kind: "cancellation_confirmation", sentAt: at("2026-09-01") });
    expect(foldEvents([cancel], TODAY)).toMatchObject({ status: "canceled", nextChargeDate: null });
    const again = ev({ kind: "receipt", sentAt: at("2026-10-05"), chargeDate: "2026-10-05", billingCycle: "monthly", amountMinor: 1299, currency: "USD" });
    expect(foldEvents([cancel, again], TODAY)).toMatchObject({ status: "active", nextChargeDate: "2026-11-05" });
  });

  it("uses a stated renewal date and updates the price on price_change", () => {
    const s = foldEvents(
      [
        ev({ kind: "receipt", sentAt: at("2025-10-20"), amountMinor: 13900, currency: "USD", billingCycle: "yearly", chargeDate: "2025-10-20" }),
        ev({ kind: "price_change", sentAt: at("2026-09-01"), amountMinor: 14900, currency: "USD" }),
        ev({ kind: "renewal_notice", sentAt: at("2026-10-06"), nextChargeDate: "2026-10-20" }),
      ],
      TODAY,
    );
    expect(s).toMatchObject({ status: "active", amountMinor: 14900, nextChargeDate: "2026-10-20" });
    expect(s.priceChangedAt).toEqual(at("2026-09-01"));
  });

  it("marks a monthly subscription with no email for months as stale", () => {
    const s = foldEvents(
      [ev({ kind: "receipt", sentAt: at("2026-03-01"), chargeDate: "2026-03-01", billingCycle: "monthly", amountMinor: 999, currency: "USD" })],
      TODAY,
    );
    expect(s).toMatchObject({ status: "unknown", needsReview: true, reviewReason: "stale" });
  });

  it("does not mark a yearly subscription stale within its year", () => {
    const s = foldEvents(
      [ev({ kind: "receipt", sentAt: at("2026-03-01"), chargeDate: "2026-03-01", billingCycle: "yearly", amountMinor: 9999, currency: "USD" })],
      TODAY,
    );
    expect(s).toMatchObject({ status: "active", nextChargeDate: "2027-03-01", needsReview: false });
  });

  it("flags subscriptions built only from low-confidence emails", () => {
    const s = foldEvents([ev({ kind: "receipt", sentAt: at("2026-10-01"), confidence: 0.4 })], TODAY);
    expect(s).toMatchObject({ needsReview: true, reviewReason: "low_confidence" });
  });
});
