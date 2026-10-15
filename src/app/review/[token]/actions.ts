"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db/client";
import { env } from "@/env";
import { verifyReviewToken } from "@/lib/crypto";
import { applyReviewAnswer } from "@/lib/priority/recompute";

const answerSchema = z.enum(["keep", "cancel", "not_sure"]);

/** Confirms an answer from an email link. The signed token is the only
 *  authorization: it names one user + one subscription and expires in 14 days. */
export async function submitReview(token: string, formData: FormData): Promise<void> {
  const verified = verifyReviewToken(token, env.ACTION_TOKEN_SECRET);
  const answer = answerSchema.safeParse(formData.get("answer"));
  if (!verified.ok || !answer.success) redirect(`/review/${encodeURIComponent(token)}`);
  await applyReviewAnswer(db, verified.payload.u, verified.payload.s, answer.data);
  redirect(`/review/${encodeURIComponent(token)}?done=${answer.data}`);
}
