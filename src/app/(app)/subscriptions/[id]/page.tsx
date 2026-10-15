import { ArrowLeft, CircleHelp, EyeOff, Eye, ExternalLink, PencilLine } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { price, SubscriptionAvatar, whenText } from "@/components/subscription-row";
import { button, card } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { currencyExponent } from "@/lib/money";
import { getSubscription, type SubscriptionView } from "@/lib/subscriptions/queries";
import { confirmStatus, setDismissed, updateSubscription } from "../actions";
import { SubscriptionForm } from "../subscription-form";

export const metadata: Metadata = { title: "Subscription" };

export default function SubscriptionPage({ params }: PageProps<"/subscriptions/[id]">) {
  return (
    <div className="flex flex-col gap-5">
      <Link href="/subscriptions" className="inline-flex items-center gap-1.5 self-start text-sm font-semibold text-brand-600">
        <ArrowLeft className="size-4" /> Subscriptions
      </Link>
      <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-line/70" />}>
        <Detail params={params} />
      </Suspense>
    </div>
  );
}

async function Detail({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, user] = await Promise.all([params, requireUser()]);
  const s = await getSubscription(user.id, id, user.timezone ?? "UTC");
  if (!s) notFound();
  const p = price(s);

  return (
    <div className="flex flex-col gap-5">
      <section className={`${card} p-5`}>
        <div className="flex items-center gap-4">
          <SubscriptionAvatar name={s.name} category={s.category} size="size-14" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-extrabold tracking-tight">{s.name}</h1>
            <p className="truncate text-sm text-muted">{[s.plan, label(s)].filter(Boolean).join(" · ")}</p>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <Stat label="Price">{p ?? "Unknown"}</Stat>
          <Stat label={s.status === "trial" ? "Trial ends" : s.needsReview ? "Next charge, if active" : "Next charge"}>
            {formatDate(s.nextChargeDate) ?? "Unknown"}
          </Stat>
        </div>
        <p className="mt-3 text-sm text-muted">{whenText(s)}</p>
        {s.edited.length > 0 && (
          <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-brand-600">
            <PencilLine className="size-3.5" /> Includes your edits. New emails won&apos;t change them.
          </p>
        )}
      </section>

      {s.needsReview && !s.dismissed && <ReviewPrompt s={s} />}

      {s.cancelUrl && s.status !== "canceled" && (
        <a href={s.cancelUrl} target="_blank" rel="noopener noreferrer" className={`${button.secondary} justify-between`}>
          Manage or cancel on {s.name}
          <ExternalLink className="size-4" />
        </a>
      )}

      <details className={`${card} group p-5`}>
        <summary className="flex cursor-pointer list-none items-center justify-between font-bold">
          Edit details
          <PencilLine className="size-4 text-muted transition group-open:text-brand-600" />
        </summary>
        <div className="mt-5">
          <SubscriptionForm
            action={updateSubscription.bind(null, s.id)}
            submitLabel="Save changes"
            defaults={{
              name: s.name,
              plan: s.plan ?? "",
              amount: s.amountMinor != null && s.currency ? (s.amountMinor / 10 ** currencyExponent(s.currency)).toFixed(currencyExponent(s.currency)) : "",
              currency: s.currency ?? "USD",
              cycle: s.cycle ?? "",
              nextChargeDate: s.nextChargeDate ?? "",
              status: s.status,
            }}
          />
        </div>
      </details>

      <form action={setDismissed.bind(null, s.id, !s.dismissed)}>
        <button type="submit" className={`${button.secondary} w-full text-muted`}>
          {s.dismissed ? (
            <>
              <Eye className="size-4" /> Show this subscription again
            </>
          ) : (
            <>
              <EyeOff className="size-4" /> Not a subscription? Hide it
            </>
          )}
        </button>
      </form>
    </div>
  );
}

function ReviewPrompt({ s }: { s: SubscriptionView }) {
  const copy =
    s.reviewReason === "trial_outcome_unknown"
      ? { q: "Did this free trial turn into a paid plan?", yes: "Yes, I'm paying", no: "No, I canceled" }
      : s.reviewReason === "stale"
        ? { q: "We haven't seen a receipt in a while. Are you still subscribed?", yes: "Still subscribed", no: "I canceled" }
        : { q: "We weren't sure about this one. Is it an active subscription?", yes: "Yes, it's active", no: "No, it's canceled" };
  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
      <p className="flex items-start gap-2 font-semibold">
        <CircleHelp className="mt-0.5 size-5 shrink-0 text-warning" /> {copy.q}
      </p>
      <p className="mt-1 pl-7 text-sm text-muted">We won&apos;t send reminders for it until you confirm.</p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <form action={confirmStatus.bind(null, s.id, "active")}>
          <button type="submit" className={`${button.primary} w-full px-3`}>
            {copy.yes}
          </button>
        </form>
        <form action={confirmStatus.bind(null, s.id, "canceled")}>
          <button type="submit" className={`${button.secondary} w-full px-3`}>
            {copy.no}
          </button>
        </form>
      </div>
    </section>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl bg-canvas p-3">
      <p className="text-xs font-semibold text-muted">{label}</p>
      <p className="mt-0.5 font-bold tabular-nums">{children}</p>
    </div>
  );
}

function label(s: SubscriptionView): string {
  if (s.dismissed) return "Hidden";
  return { trial: "Free trial", active: "Active", canceled: "Canceled", unknown: "Status unknown" }[s.status];
}

function formatDate(d: string | null): string | null {
  return d
    ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    : null;
}
