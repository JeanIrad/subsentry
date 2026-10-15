import { describe, expect, it } from "vitest";
import { buildCandidateQuery } from "@/lib/google/backfill-query";
import { KNOWN_SENDERS } from "@/lib/google/known-senders";

describe("buildCandidateQuery", () => {
  const q = buildCandidateQuery({ newerThanDays: 365 });

  it("limits to the backfill window", () => {
    expect(q.startsWith("newer_than:365d ")).toBe(true);
  });

  it("matches billing subjects or known senders", () => {
    expect(q).toContain('subject:(receipt OR invoice OR subscription OR "free trial"');
    expect(q).toContain("from:(netflix.com OR ");
  });

  it("requires billing terms for sender-only matches", () => {
    expect(q).toMatch(/from:\([^)]*\) \(subscription OR membership OR billing/);
  });

  it("excludes social/forum noise", () => {
    expect(q).toContain("-category:social");
    expect(q).toContain("-category:forums");
  });

  it("has balanced parentheses", () => {
    let depth = 0;
    for (const ch of q) {
      depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});

describe("KNOWN_SENDERS", () => {
  it("contains bare, unique domains", () => {
    expect(new Set(KNOWN_SENDERS).size).toBe(KNOWN_SENDERS.length);
    for (const d of KNOWN_SENDERS) expect(d).toMatch(/^[a-z0-9.-]+\.[a-z]+$/);
  });

  it("leaves out broad senders whose mail is mostly not billing", () => {
    for (const broad of ["google.com", "amazon.com", "apple.com"]) {
      expect(KNOWN_SENDERS).not.toContain(broad);
    }
  });
});
