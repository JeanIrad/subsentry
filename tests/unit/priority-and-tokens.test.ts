import { describe, expect, it } from "vitest";
import { createReviewToken, verifyReviewToken } from "@/lib/crypto";
import { computePriorities, explainPriority, priorityLevel, type PriorityInput } from "@/lib/priority/score";

const SECRET = "x".repeat(40);

describe("review tokens", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  const token = createReviewToken({ userId: "u1", subscriptionId: "s1" }, SECRET, now);

  it("round-trips", () => {
    expect(verifyReviewToken(token, SECRET, now)).toMatchObject({ ok: true, payload: { u: "u1", s: "s1" } });
  });

  it("rejects tampering, wrong secrets and garbage", () => {
    const [data, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "u1", s: "OTHER", e: 9e9 })).toString("base64url");
    expect(verifyReviewToken(`${forged}.${sig}`, SECRET, now)).toEqual({ ok: false, reason: "invalid" });
    expect(verifyReviewToken(`${data}.${sig}x`, SECRET, now)).toEqual({ ok: false, reason: "invalid" });
    expect(verifyReviewToken(token, "y".repeat(40), now)).toEqual({ ok: false, reason: "invalid" });
    expect(verifyReviewToken("nope", SECRET, now)).toEqual({ ok: false, reason: "invalid" });
    expect(verifyReviewToken(`${token}.extra`, SECRET, now)).toEqual({ ok: false, reason: "invalid" });
  });

  it("expires after 14 days", () => {
    expect(verifyReviewToken(token, SECRET, new Date("2026-10-29T11:59:00Z")).ok).toBe(true);
    expect(verifyReviewToken(token, SECRET, new Date("2026-10-29T12:01:00Z"))).toEqual({ ok: false, reason: "expired" });
  });
});

const sub = (id: string, p: Partial<PriorityInput> = {}): PriorityInput => ({
  id,
  status: "active",
  dismissed: false,
  category: "other",
  amountMinor: 1000,
  currency: "USD",
  billingCycle: "monthly",
  reviewAnswer: null,
  ...p,
});

describe("computePriorities", () => {
  it("starts at 50 and moves with the user's answer", () => {
    const r = computePriorities([sub("a", { reviewAnswer: "keep" }), sub("b", { reviewAnswer: "cancel" }), sub("c")]);
    expect(r.get("a")?.score).toBe(85);
    expect(r.get("b")?.score).toBe(10);
    expect(r.get("c")?.score).toBe(50);
  });

  it("treats unconfirmed trials as Not sure", () => {
    const r = computePriorities([sub("t", { status: "trial" })]);
    expect(r.get("t")?.factors.review).toBe(0);
  });

  it("lowers the priciest and raises the cheapest (per currency)", () => {
    const r = computePriorities([
      sub("cheap", { amountMinor: 500 }),
      sub("mid", { amountMinor: 1500 }),
      sub("pricey", { amountMinor: 13900, billingCycle: "yearly" }), // 1158/mo → mid-ish
      sub("top", { amountMinor: 5000 }),
      sub("eur", { amountMinor: 99999, currency: "EUR" }),
    ]);
    expect(r.get("cheap")?.factors.cost).toBe(5);
    expect(r.get("top")?.factors.cost).toBe(-5);
    expect(r.get("eur")?.factors.cost).toBe(0); // no EUR peers
  });

  it("penalises a 3rd subscription in the same category", () => {
    const two = computePriorities([sub("a", { category: "video" }), sub("b", { category: "video" })]);
    expect(two.get("a")?.factors.overlap).toBe(0);
    const three = computePriorities([sub("a", { category: "video" }), sub("b", { category: "video" }), sub("c", { category: "video" })]);
    expect(three.get("a")?.factors).toMatchObject({ overlap: -10, overlapCount: 3 });
  });

  it("ignores canceled and hidden subscriptions entirely", () => {
    const r = computePriorities([
      sub("a", { category: "video" }),
      sub("b", { category: "video", status: "canceled" }),
      sub("c", { category: "video", dismissed: true }),
    ]);
    expect([...r.keys()]).toEqual(["a"]);
    expect(r.get("a")?.factors.overlap).toBe(0);
  });

  it("clamps and explains", () => {
    const r = computePriorities([
      sub("a", { category: "video", reviewAnswer: "cancel", amountMinor: 9999 }),
      sub("b", { category: "video" }),
      sub("c", { category: "video" }),
    ]);
    const a = r.get("a")!;
    expect(a.score).toBe(0); // 50 − 40 − 5 − 10 → clamped
    expect(priorityLevel(a.score)).toBe("low");
    expect(explainPriority(a.factors, "video", "cancel")).toEqual([
      "You said you plan to cancel",
      "One of 3 video subscriptions",
      "Among your most expensive",
    ]);
  });
});
