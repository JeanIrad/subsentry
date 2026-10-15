"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db/client";
import { subscriptions } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { syncSubscription } from "@/lib/jobs/boss";
import { categoryFor } from "@/lib/ledger/categories";
import { overridesSchema, recomputeSubscription, type Overrides } from "@/lib/ledger/merge";
import { merchantKey } from "@/lib/ledger/normalize";
import { isSupportedCurrency, toMinorUnits } from "@/lib/money";

export interface FormState {
  error?: string;
  fieldErrors?: Partial<Record<"name" | "amount" | "currency" | "nextChargeDate", string>>;
}

const formSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(100),
  plan: z.string().trim().max(100).transform((v) => v || null),
  amount: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{1,7}([.,]\d{1,3})?$/.test(v), "Enter a price like 11.99"),
  currency: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine(isSupportedCurrency, "Use a 3-letter code like USD"),
  cycle: z.enum(["weekly", "monthly", "quarterly", "yearly", "other", ""]).transform((v) => v || null),
  nextChargeDate: z.union([z.literal(""), z.iso.date("Pick a valid date")]).transform((v) => v || null),
  status: z.enum(["trial", "active", "canceled", "unknown"]),
});

function parseForm(formData: FormData): { ok: true; values: Required<Overrides> } | { ok: false; state: FormState } {
  const parsed = formSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const fieldErrors: FormState["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const k = issue.path[0] as keyof NonNullable<FormState["fieldErrors"]>;
      fieldErrors[k] ??= issue.message;
    }
    return { ok: false, state: { fieldErrors } };
  }
  const v = parsed.data;
  return {
    ok: true,
    values: {
      merchantName: v.name,
      planName: v.plan,
      amountMinor: v.amount === "" ? null : toMinorUnits(Number(v.amount.replace(",", ".")), v.currency),
      currency: v.currency,
      billingCycle: v.cycle,
      nextChargeDate: v.nextChargeDate,
      status: v.status,
      category: categoryFor(merchantKey(v.name)),
    },
  };
}

async function ownedSubscription(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.id, id), eq(subscriptions.userId, userId)));
  if (!row) throw new Error("Subscription not found");
  return row;
}

export async function updateSubscription(id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const row = await ownedSubscription(user.id, id);
  const parsed = parseForm(formData);
  if (!parsed.ok) return parsed.state;

  // Override only what the user actually changed; emails keep updating the rest.
  const current: Required<Overrides> = {
    merchantName: row.merchantName,
    planName: row.planName,
    amountMinor: row.amountMinor,
    currency: row.currency,
    billingCycle: row.billingCycle,
    nextChargeDate: row.nextChargeDate,
    status: row.status,
    category: (row.category ?? "other") as Required<Overrides>["category"],
  };
  const overrides: Overrides = overridesSchema.catch({}).parse(row.userOverrides);
  for (const k of Object.keys(parsed.values) as (keyof Overrides)[]) {
    if (k === "category") continue; // derived from the name, not edited directly
    if (parsed.values[k] !== current[k]) Object.assign(overrides, { [k]: parsed.values[k] });
  }
  await db.update(subscriptions).set({ userOverrides: overrides }).where(eq(subscriptions.id, id));
  await recomputeSubscription(db, id);
  await syncSubscription(id);
  refresh();
  return {};
}

export async function addSubscription(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const parsed = parseForm(formData);
  if (!parsed.ok) return parsed.state;

  const key = merchantKey(parsed.values.merchantName);
  const [created] = await db
    .insert(subscriptions)
    .values({
      userId: user.id,
      merchantKey: key,
      merchantName: parsed.values.merchantName,
      category: parsed.values.category,
      userOverrides: parsed.values,
    })
    .onConflictDoNothing()
    .returning({ id: subscriptions.id });
  if (!created) {
    return { fieldErrors: { name: `You already have ${parsed.values.merchantName}. Edit that one instead.` } };
  }
  await recomputeSubscription(db, created.id);
  await syncSubscription(created.id);
  redirect(`/subscriptions/${created.id}`);
}

/** One-tap answers to "Still subscribed?" / "Did this trial convert?". */
export async function confirmStatus(id: string, status: "active" | "canceled"): Promise<void> {
  const user = await requireUser();
  const row = await ownedSubscription(user.id, id);
  const overrides = { ...overridesSchema.catch({}).parse(row.userOverrides), status };
  await db.update(subscriptions).set({ userOverrides: overrides }).where(eq(subscriptions.id, id));
  await recomputeSubscription(db, id);
  await syncSubscription(id);
  refresh();
}

/** Hide a wrong detection (or bring it back). Hidden items get no reminders. */
export async function setDismissed(id: string, dismissed: boolean): Promise<void> {
  const user = await requireUser();
  await ownedSubscription(user.id, id);
  await db.update(subscriptions).set({ dismissed }).where(eq(subscriptions.id, id));
  await syncSubscription(id);
  refresh();
}

/** Turn reminders (email + calendar) off or on for one subscription (SPEC FR-13). */
export async function setQuiet(id: string, quiet: boolean): Promise<void> {
  const user = await requireUser();
  await ownedSubscription(user.id, id);
  await db.update(subscriptions).set({ quiet }).where(eq(subscriptions.id, id));
  await syncSubscription(id);
  refresh();
}
