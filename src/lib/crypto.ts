import { createHmac, timingSafeEqual } from "node:crypto";

// Signed, expiring tokens for links in reminder emails (ARCHITECTURE §3.6).
// A token authorizes exactly one thing: answering Keep / Cancel / Not sure for
// one subscription of one user. Format: base64url(json).base64url(hmac).

export interface ReviewTokenPayload {
  /** user id */
  u: string;
  /** subscription id */
  s: string;
  /** expiry, unix seconds */
  e: number;
}

export const REVIEW_TOKEN_TTL_DAYS = 14;
const PURPOSE = "review.v1";

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(`${PURPOSE}.${data}`).digest("base64url");
}

export function createReviewToken(
  p: { userId: string; subscriptionId: string },
  secret: string,
  now = new Date(),
): string {
  const payload: ReviewTokenPayload = {
    u: p.userId,
    s: p.subscriptionId,
    e: Math.floor(now.getTime() / 1000) + REVIEW_TOKEN_TTL_DAYS * 86_400,
  };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${sign(data, secret)}`;
}

export type VerifyResult = { ok: true; payload: ReviewTokenPayload } | { ok: false; reason: "invalid" | "expired" };

export function verifyReviewToken(token: string, secret: string, now = new Date()): VerifyResult {
  const [data, sig, extra] = token.split(".");
  if (!data || !sig || extra !== undefined) return { ok: false, reason: "invalid" };
  const expected = Buffer.from(sign(data, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "invalid" };

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const p = payload as Partial<ReviewTokenPayload>;
  if (typeof p.u !== "string" || typeof p.s !== "string" || typeof p.e !== "number") return { ok: false, reason: "invalid" };
  if (p.e * 1000 < now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, payload: { u: p.u, s: p.s, e: p.e } };
}
