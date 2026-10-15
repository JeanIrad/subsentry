import { convert } from "html-to-text";
import type { EmailMessage } from "@/lib/google/gmail";

// ~6k tokens. Receipts put the important bits (price, dates) near the top.
export const MAX_BODY_CHARS = 24_000;

/** Plain-text body for the LLM: HTML converted, quoted replies and boilerplate trimmed. */
export function emailBodyText(msg: Pick<EmailMessage, "text" | "html">): string {
  // Many senders put a stub ("view this email in your browser") in text/plain.
  const plain = msg.text?.trim() ?? "";
  const raw = plain.length >= 200 || !msg.html ? plain : htmlToText(msg.html);
  return truncate(stripNoise(raw), MAX_BODY_CHARS);
}

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "script", format: "skip" },
      // Keep link URLs: the cancellation link is one of the fields we extract.
      { selector: "a", options: { hideLinkHrefIfSameAsText: true, ignoreHref: false } },
      { selector: "table", format: "dataTable", options: { uppercaseHeaderCells: false } },
    ],
  });
}

const QUOTE_MARKERS = [
  /^On .+ wrote:$/m, // Gmail/Apple reply header
  /^-{2,}\s*Original Message\s*-{2,}$/im,
  /^-{2,}\s*Forwarded message\s*-{2,}$/im,
];

export function stripNoise(text: string): string {
  let out = text;
  for (const marker of QUOTE_MARKERS) {
    const m = marker.exec(out);
    if (m && m.index > 200) out = out.slice(0, m.index);
  }
  return (
    out
      .split("\n")
      .filter((line) => !line.trimStart().startsWith(">")) // quoted lines
      // Tracking URLs are long and carry no meaning for extraction.
      .map((line) => line.replace(/\[?https?:\/\/\S{120,}\]?/g, "[link]"))
      .join("\n")
      .replace(/[ \t ‌​]+/g, " ")
      .replace(/\n\s*\n\s*\n+/g, "\n\n")
      .trim()
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[…truncated]`;
}
