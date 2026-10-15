"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { gmailSyncState, users } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { enqueueBackfill } from "@/lib/jobs/boss";

const timezoneSchema = z
  .string()
  .refine((tz) => Intl.supportedValuesOf("timeZone").includes(tz) || tz === "UTC", "Unknown timezone");

export async function saveTimezone(timezone: string): Promise<void> {
  const user = await requireUser();
  const tz = timezoneSchema.parse(timezone);
  await db.update(users).set({ timezone: tz }).where(eq(users.id, user.id));
}

export async function startScan(): Promise<void> {
  const user = await requireUser();
  await db
    .insert(gmailSyncState)
    .values({ userId: user.id, backfillStatus: "pending" })
    .onConflictDoUpdate({
      target: gmailSyncState.userId,
      set: { backfillStatus: "pending", lastError: null },
    });
  await enqueueBackfill(user.id);
}
