import { describe, expect, it } from "vitest";
import { emailBodyText, htmlToText, stripNoise } from "@/lib/extract/html-to-text";
import { parseMessage, senderDomain } from "@/lib/google/gmail";
import { createPacer } from "@/worker/pacer";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

describe("parseMessage", () => {
  it("reads headers and the first text/plain and text/html parts, skipping attachments", () => {
    const msg = parseMessage({
      id: "m1",
      internalDate: String(Date.UTC(2026, 8, 15, 10)),
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "Netflix <info@mailer.netflix.com>" },
          { name: "subject", value: "Your bill" },
        ],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: b64("Plain body €9.99") } },
              { mimeType: "text/html", body: { data: b64("<p>HTML body</p>") } },
            ],
          },
          { mimeType: "text/plain", filename: "invoice.txt", body: { data: b64("attachment") } },
        ],
      },
    });
    expect(msg).toEqual({
      id: "m1",
      from: "Netflix <info@mailer.netflix.com>",
      subject: "Your bill",
      date: "2026-09-15T10:00:00.000Z",
      text: "Plain body €9.99",
      html: "<p>HTML body</p>",
    });
  });
});

describe("senderDomain", () => {
  it("extracts the lowercased domain", () => {
    expect(senderDomain("Spotify <No-Reply@Spotify.com>")).toBe("spotify.com");
    expect(senderDomain("billing@mailer.netflix.com")).toBe("mailer.netflix.com");
    expect(senderDomain("no address")).toBeNull();
  });
});

describe("emailBodyText", () => {
  it("prefers HTML when text/plain is only a stub", () => {
    const body = emailBodyText({
      text: "View this email in your browser",
      html: "<table><tr><td>Plan</td><td>Premium</td></tr><tr><td>Total</td><td>$11.99</td></tr></table>",
    });
    expect(body).toContain("Premium");
    expect(body).toContain("$11.99");
  });

  it("drops scripts, styles and images but keeps link URLs", () => {
    const text = htmlToText(
      '<style>.x{}</style><script>alert(1)</script><img src="a.png" alt="logo"><a href="https://ex.com/cancel">Cancel</a>',
    );
    expect(text).not.toContain("alert");
    expect(text).not.toContain(".x");
    expect(text).toContain("https://ex.com/cancel");
  });

  it("truncates very long bodies", () => {
    const body = emailBodyText({ text: "word ".repeat(10_000), html: null });
    expect(body.length).toBeLessThan(24_100);
    expect(body.endsWith("[…truncated]")).toBe(true);
  });
});

describe("stripNoise", () => {
  it("removes quoted replies and collapses whitespace", () => {
    const text = `${"Receipt line. ".repeat(20)}\n\n\n\nThanks\n> quoted line\nOn Mon, Sep 1, 2026 at 9:00 AM Someone wrote:\nold stuff`;
    const out = stripNoise(text);
    expect(out).not.toContain("quoted line");
    expect(out).not.toContain("old stuff");
    expect(out).not.toMatch(/\n\n\n/);
  });

  it("replaces very long tracking URLs", () => {
    expect(stripNoise(`Manage: https://t.example.com/${"x".repeat(200)}`)).toBe("Manage: [link]");
  });
});

describe("createPacer", () => {
  it("spaces calls by the minimum interval and honours push-backs", async () => {
    const pacer = createPacer(30);
    const t0 = Date.now();
    await pacer.wait();
    await pacer.wait();
    await pacer.wait();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
    pacer.pushBack(0.1);
    const t1 = Date.now();
    await pacer.wait();
    expect(Date.now() - t1).toBeGreaterThanOrEqual(90);
  });

  it("throws instead of sleeping through a long quota wait", async () => {
    const pacer = createPacer(0, 1000);
    pacer.pushBack(3600);
    await expect(pacer.wait()).rejects.toMatchObject({ name: "LLMRateLimitError" });
  });
});
