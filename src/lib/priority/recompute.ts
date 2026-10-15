import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { subscriptions } from "@/db/schema";
import { computePriorities, type ReviewAnswer } from "./score";

/** Recomputes and stores priority for all of a user's subscriptions
 *  (scores are relative, so one change can move the others). Cheap enough to
 *  run inline after any change. */
export async function recomputePriorities(db: Db, userId: string): Promise<void> {
  const rows = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  const results = computePriorities(rows);
  await db.transaction(async (tx) => {
    for (const r of rows) {
      const p = results.get(r.id);
      const score = p?.score ?? null;
      const factors = p ? { ...p.factors } : null;
      if (r.priorityScore === score && JSON.stringify(r.priorityFactors) === JSON.stringify(factors)) continue;
      await tx
        .update(subscriptions)
        .set({ priorityScore: score, priorityFactors: factors as Record<string, number> | null })
        .where(eq(subscriptions.id, r.id));
    }
  });
}

/** Records Keep / Cancel / Not sure (from the app or an email link). */
export async function applyReviewAnswer(db: Db, userId: string, subscriptionId: string, answer: ReviewAnswer): Promise<boolean> {
  const updated = await db
    .update(subscriptions)
    .set({ reviewAnswer: answer })
    .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.userId, userId)))
    .returning({ id: subscriptions.id });
  if (updated.length === 0) return false;
  await recomputePriorities(db, userId);
  return true;
}
