import { describe, expect, it } from "vitest";
import { planReminders, type PlanInput } from "@/lib/reminders/plan";

const base: PlanInput = {
  status: "active",
  nextChargeDate: "2026-11-20",
  needsReview: false,
  quiet: false,
  dismissed: false,
  timezone: "America/New_York",
  now: new Date("2026-10-15T12:00:00Z"),
  alreadyPlanned: false,
};

const summary = (i: Partial<PlanInput>) =>
  planReminders({ ...base, ...i }).map((r) => `${r.offsetDays}d@${r.sendAt.toISOString()}`);

describe("planReminders", () => {
  it("plans 14/7/1 days before a renewal at 9:00 local time", () => {
    expect(summary({})).toEqual([
      "14d@2026-11-06T14:00:00.000Z", // 9:00 EST (after DST ends Nov 1)
      "7d@2026-11-13T14:00:00.000Z",
      "1d@2026-11-19T14:00:00.000Z",
    ]);
  });

  it("uses the user's timezone across DST", () => {
    expect(summary({ nextChargeDate: "2026-10-30" })).toEqual([
      "14d@2026-10-16T13:00:00.000Z", // 9:00 EDT
      "7d@2026-10-23T13:00:00.000Z",
      "1d@2026-10-29T13:00:00.000Z",
    ]);
    expect(summary({ nextChargeDate: "2026-10-30", timezone: "Africa/Kigali" })[0]).toBe("14d@2026-10-16T07:00:00.000Z");
  });

  it("plans 7/3/1 days before a trial ends, counted from the day before", () => {
    const r = planReminders({ ...base, status: "trial", nextChargeDate: "2026-11-20" });
    expect(r.map((x) => [x.offsetDays, x.sendAt.toISOString().slice(0, 10), x.chargeDate])).toEqual([
      [7, "2026-11-12", "2026-11-20"],
      [3, "2026-11-16", "2026-11-20"],
      [1, "2026-11-18", "2026-11-20"],
    ]);
  });

  it("skips offsets already in the past", () => {
    expect(summary({ nextChargeDate: "2026-10-25" })).toEqual(["7d@2026-10-18T13:00:00.000Z", "1d@2026-10-24T13:00:00.000Z"]);
  });

  it("sends one reminder right away when found too late for the regular ones", () => {
    const r = planReminders({ ...base, status: "trial", nextChargeDate: "2026-10-16" });
    expect(r).toEqual([{ chargeDate: "2026-10-16", offsetDays: 1, sendAt: base.now }]);
    expect(planReminders({ ...base, status: "trial", nextChargeDate: "2026-10-16", alreadyPlanned: true })).toEqual([]);
  });

  it.each([
    ["canceled", { status: "canceled" as const }],
    ["unknown status", { status: "unknown" as const }],
    ["needs review", { needsReview: true }],
    ["quiet", { quiet: true }],
    ["hidden", { dismissed: true }],
    ["no date", { nextChargeDate: null }],
    ["date passed", { nextChargeDate: "2026-10-01" }],
  ])("plans nothing when %s", (_label, patch) => {
    expect(planReminders({ ...base, ...patch })).toEqual([]);
  });
});
