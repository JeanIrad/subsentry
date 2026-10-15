import { describe, expect, it } from "vitest";
import { extractEmail, ExtractionInvalidError, normalize } from "@/lib/extract/extract";
import { extractionJsonSchema, type Extraction } from "@/lib/extract/schema";
import type { StructuredLLM, StructuredRequest } from "@/lib/llm/types";

const email = {
  from: "Spotify <no-reply@spotify.com>",
  subject: "Your receipt",
  date: "2026-09-15T10:00:00.000Z",
  body: "Premium Individual $11.99. Next payment on October 15, 2026.",
};

const good: Extraction = {
  kind: "receipt",
  merchant: "Spotify",
  plan: "Premium Individual",
  amount: 11.99,
  currency: "USD",
  billing_cycle: "monthly",
  charge_date: "2026-09-15",
  next_charge_date: "2026-10-15",
  trial_end_date: null,
  cancel_url: null,
  confidence: 0.95,
};

function fakeLLM(responses: string[]): StructuredLLM & { calls: StructuredRequest[] } {
  const calls: StructuredRequest[] = [];
  return {
    model: "fake-1",
    calls,
    async generateJson(req) {
      calls.push(req);
      const text = responses[calls.length - 1];
      if (text === undefined) throw new Error("no more fake responses");
      return { text, model: "fake-1" };
    },
  };
}

describe("extractEmail", () => {
  it("returns validated output on the first try", async () => {
    const llm = fakeLLM([JSON.stringify(good)]);
    const { extraction, model } = await extractEmail(llm, email);
    expect(extraction).toEqual(good);
    expect(model).toBe("fake-1");
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].user).toContain("Sent: 2026-09-15");
    expect(llm.calls[0].jsonSchema).toBe(extractionJsonSchema);
  });

  it("retries once with the validation error, then succeeds", async () => {
    const llm = fakeLLM([JSON.stringify({ ...good, kind: "invoice" }), JSON.stringify(good)]);
    const { extraction } = await extractEmail(llm, email);
    expect(extraction.kind).toBe("receipt");
    expect(llm.calls[1].user).toMatch(/previous answer was invalid \(kind:/);
  });

  it("gives up after two invalid answers", async () => {
    const llm = fakeLLM(["not json", "{}"]);
    await expect(extractEmail(llm, email)).rejects.toBeInstanceOf(ExtractionInvalidError);
    expect(llm.calls).toHaveLength(2);
  });

  it("accepts JSON wrapped in code fences", async () => {
    const llm = fakeLLM(["```json\n" + JSON.stringify(good) + "\n```"]);
    expect((await extractEmail(llm, email)).extraction.merchant).toBe("Spotify");
  });

  it("nulls soft fields instead of failing", async () => {
    const llm = fakeLLM([JSON.stringify({ ...good, currency: "dollars", cancel_url: "javascript:alert(1)" })]);
    const { extraction } = await extractEmail(llm, email);
    expect(extraction.currency).toBeNull();
    expect(extraction.amount).toBeNull(); // no currency → no amount
    expect(extraction.cancel_url).toBeNull();
  });

  it("does not leak the raw model text in errors", async () => {
    const secret = "CARD ENDING 4242";
    const llm = fakeLLM([`{"kind":"${secret}"}`, `{"kind":"${secret}"}`]);
    const err = await extractEmail(llm, email).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractionInvalidError);
    expect((err as Error).message).not.toContain(secret);
  });
});

describe("normalize", () => {
  it("clears fields on not_subscription", () => {
    const out = normalize({ ...good, kind: "not_subscription" }, email.date);
    expect(out).toMatchObject({ merchant: null, amount: null, next_charge_date: null });
  });

  it("drops implausible dates", () => {
    const out = normalize({ ...good, next_charge_date: "2031-01-01", charge_date: "2019-01-01" }, email.date);
    expect(out.next_charge_date).toBeNull();
    expect(out.charge_date).toBeNull();
  });
});
