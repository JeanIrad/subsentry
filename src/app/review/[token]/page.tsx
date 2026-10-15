import { and, eq } from "drizzle-orm";
import { CheckCircle2, CircleHelp, ExternalLink, Heart, Scissors } from "lucide-react";
import type { Metadata } from "next";
import { connection } from "next/server";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { Logo } from "@/components/logo";
import { price, SubscriptionAvatar } from "@/components/subscription-row";
import { button, card } from "@/components/ui";
import { db } from "@/db/client";
import { subscriptions } from "@/db/schema";
import { env } from "@/env";
import { verifyReviewToken } from "@/lib/crypto";
import { submitReview } from "./actions";

// Opened from the Keep / Cancel / Not sure buttons in a reminder email.
// GET never changes anything (mail scanners open every link); the user
// confirms with one tap, which posts the answer.

export const metadata: Metadata = { title: "Your decision", robots: { index: false } };

type Answer = "keep" | "cancel" | "not_sure";
const OPTIONS: { value: Answer; label: string; hint: string; icon: ReactNode }[] = [
  { value: "keep", label: "Keep it", hint: "I use it and want to keep paying.", icon: <Heart className="size-5" /> },
  { value: "cancel", label: "Cancel it", hint: "I'll cancel before the next charge.", icon: <Scissors className="size-5" /> },
  { value: "not_sure", label: "Not sure", hint: "Remind me again before I'm charged.", icon: <CircleHelp className="size-5" /> },
];

export default function ReviewPage(props: PageProps<"/review/[token]">) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="pt-safe">
        <div className="mx-auto flex max-w-lg items-center px-5 py-4">
          <Logo />
        </div>
      </header>
      <main className="mx-auto w-full max-w-lg flex-1 px-4 pb-12">
        <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-line/70" />}>
          <Review {...props} />
        </Suspense>
      </main>
    </div>
  );
}

async function Review({ params, searchParams }: PageProps<"/review/[token]">) {
  const [{ token }, query] = await Promise.all([params, searchParams]);
  // Expiry is checked against the current time, so this must render per request.
  await connection();
  const verified = verifyReviewToken(token, env.ACTION_TOKEN_SECRET);
  if (!verified.ok) {
    return (
      <Message title={verified.reason === "expired" ? "This link has expired" : "This link isn't valid"}>
        {verified.reason === "expired"
          ? "Links in reminder emails work for 14 days. You can still update this subscription in the app."
          : "It may have been copied incompletely. Open SubSentry to update your subscriptions."}
      </Message>
    );
  }

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.id, verified.payload.s), eq(subscriptions.userId, verified.payload.u)));
  if (!sub) return <Message title="Subscription not found">It may have been removed. Open SubSentry to see your list.</Message>;

  const view = { amountMinor: sub.amountMinor, currency: sub.currency, cycle: sub.billingCycle };
  const done = OPTIONS.find((o) => o.value === query.done);
  const preselect = OPTIONS.find((o) => o.value === query.a)?.value ?? sub.reviewAnswer ?? "keep";

  return (
    <div className="flex flex-col gap-5">
      <section className={`${card} flex items-center gap-4 p-5`}>
        <SubscriptionAvatar name={sub.merchantName} category={sub.category ?? "other"} size="size-14" />
        <div className="min-w-0">
          <h1 className="truncate text-xl font-extrabold tracking-tight">{sub.merchantName}</h1>
          <p className="text-sm text-muted">{[price(view), sub.planName].filter(Boolean).join(" · ")}</p>
        </div>
      </section>

      {done ? (
        <section className={`${card} p-6 text-center`}>
          <CheckCircle2 className="mx-auto size-10 text-success" />
          <h2 className="mt-3 text-xl font-bold">Saved: {done.label}</h2>
          <p className="mt-1 text-sm text-muted">
            {done.value === "cancel"
              ? "We'll keep reminding you until it's canceled, so it doesn't slip through."
              : done.value === "keep"
                ? "Got it. We'll still remind you before each charge."
                : "No problem. We'll remind you again before you're charged."}
          </p>
          <div className="mt-5 flex flex-col gap-2">
            {done.value === "cancel" && sub.cancelUrl && (
              <a href={sub.cancelUrl} target="_blank" rel="noopener noreferrer" className={button.primary}>
                Cancel on {sub.merchantName} <ExternalLink className="size-4" />
              </a>
            )}
            <Link href={`/subscriptions/${sub.id}`} className={button.secondary}>
              Open in SubSentry
            </Link>
          </div>
        </section>
      ) : (
        <form action={submitReview.bind(null, token)} className="flex flex-col gap-3">
          <h2 className="px-1 text-lg font-bold">Do you want to keep it?</h2>
          {OPTIONS.map((o) => (
            <label
              key={o.value}
              className="flex cursor-pointer items-center gap-4 rounded-2xl border-2 border-line bg-surface p-4 transition has-checked:border-brand-500 has-checked:bg-brand-50"
            >
              <input type="radio" name="answer" value={o.value} defaultChecked={o.value === preselect} className="sr-only" />
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">{o.icon}</span>
              <span>
                <span className="block font-semibold">{o.label}</span>
                <span className="block text-sm text-muted">{o.hint}</span>
              </span>
            </label>
          ))}
          <button type="submit" className={`${button.primary} mt-2 w-full`}>
            Confirm
          </button>
        </form>
      )}
    </div>
  );
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={`${card} p-6 text-center`}>
      <h1 className="text-xl font-bold">{title}</h1>
      <p className="mt-2 text-sm text-muted">{children}</p>
      <Link href="/dashboard" className={`${button.primary} mt-5 w-full`}>
        Open SubSentry
      </Link>
    </section>
  );
}
