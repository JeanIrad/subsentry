import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { SubscriptionRowLink } from "@/components/subscription-row";
import { button, card } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { listSubscriptions, type SubscriptionView } from "@/lib/subscriptions/queries";

export const metadata: Metadata = { title: "Subscriptions" };

export default function SubscriptionsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Subscriptions</h1>
        <Link href="/subscriptions/new" className={`${button.primary} px-4 py-2.5`}>
          <Plus className="size-4" /> Add
        </Link>
      </div>
      <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-line/70" />}>
        <SubscriptionList />
      </Suspense>
    </div>
  );
}

async function SubscriptionList() {
  const user = await requireUser();
  const all = await listSubscriptions(user.id, user.timezone ?? "UTC");
  const visible = all.filter((s) => !s.dismissed);

  const review = visible.filter((s) => s.needsReview && s.status !== "canceled");
  const rest = visible.filter((s) => !review.includes(s));
  const trials = rest.filter((s) => s.status === "trial");
  const active = rest.filter((s) => s.status === "active" || s.status === "unknown");
  const canceled = rest.filter((s) => s.status === "canceled");
  const hidden = all.filter((s) => s.dismissed);

  if (visible.length === 0 && hidden.length === 0) {
    return (
      <div className={`${card} p-8 text-center`}>
        <h2 className="text-lg font-bold">Nothing here yet</h2>
        <p className="mt-1 text-sm text-muted">
          Subscriptions appear here as we read your receipts. You can also add one yourself.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Group title="Needs your review" hint="We weren't sure about these. Tap to confirm." items={review} tone="warning" />
      <Group title="Free trials" items={trials} />
      <Group title="Active" items={active} />
      <Group title="Canceled" items={canceled} />
      {hidden.length > 0 && (
        <details className={`${card} p-2`}>
          <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-muted">
            Hidden ({hidden.length})
          </summary>
          <ul>
            {hidden.map((s) => (
              <li key={s.id}>
                <SubscriptionRowLink s={s} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Group(props: { title: string; hint?: string; items: SubscriptionView[]; tone?: "warning" }): ReactNode {
  if (props.items.length === 0) return null;
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 className={`text-sm font-bold tracking-wide uppercase ${props.tone === "warning" ? "text-warning" : "text-muted"}`}>
          {props.title}
        </h2>
        <span className="text-sm text-muted">{props.items.length}</span>
      </div>
      {props.hint && <p className="mb-2 px-1 text-sm text-muted">{props.hint}</p>}
      <ul className={`${card} divide-y divide-line p-1.5`}>
        {props.items.map((s) => (
          <li key={s.id}>
            <SubscriptionRowLink s={s} />
          </li>
        ))}
      </ul>
    </section>
  );
}
