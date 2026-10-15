import { describe, expect, it } from "vitest";
import { currencyExponent, formatMoney, toMinorUnits } from "@/lib/money";

describe("currencyExponent", () => {
  it("knows 0-, 2- and 3-decimal currencies", () => {
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("usd")).toBe(2);
    expect(currencyExponent("KWD")).toBe(3);
  });

  it("rejects unknown codes", () => {
    expect(() => currencyExponent("XYZ")).toThrow(RangeError);
    expect(() => currencyExponent("dollars")).toThrow(RangeError);
  });
});

describe("toMinorUnits", () => {
  it("converts major units per currency", () => {
    expect(toMinorUnits(11.99, "USD")).toBe(1199);
    expect(toMinorUnits(1500, "JPY")).toBe(1500);
    expect(toMinorUnits(1.234, "KWD")).toBe(1234);
  });

  it("is not fooled by binary float error", () => {
    expect(toMinorUnits(1.005, "USD")).toBe(101);
    expect(toMinorUnits(0.29, "EUR")).toBe(29);
    expect(toMinorUnits(19.99 * 3, "USD")).toBe(5997);
  });

  it("rejects non-finite amounts", () => {
    expect(() => toMinorUnits(Number.NaN, "USD")).toThrow(RangeError);
    expect(() => toMinorUnits(Number.POSITIVE_INFINITY, "USD")).toThrow(RangeError);
  });
});

describe("formatMoney", () => {
  it("formats minor units", () => {
    expect(formatMoney(1199, "USD")).toBe("$11.99");
    expect(formatMoney(1500, "JPY")).toBe("¥1,500");
  });
});
