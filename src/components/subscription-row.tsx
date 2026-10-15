import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { formatMoney } from "@/lib/money";
import type { SubscriptionView } from "@/lib/subscriptions/queries";

const CYCLE_SUFFIX: Record<string, string> = { weekly: "/wk", monthly: "/mo", quarterly: "/qtr", yearly: "/yr" };

// Soft tint per category so the list is scannable at a glance.
const CATEGORY_TINT: Record<string, string> = {
  video: "bg-brand-100 text-brand-700",
  music: "bg-sky-100 text-sky-700",
  news: "bg-slate-100 text-slate-700",
  software: "bg-indigo-100 text-indigo-700",
  cloud: "bg-cyan-100 text-cyan-700",
  fitness: "bg-teal-100 text-teal-700",
  learning: "bg-violet-100 text-violet-700",
  gaming: "bg-blue-100 text-blue-800",
  food: "bg-amber-100 text-amber-800",
  other: "bg-canvas text-muted",
};

export function price(s: Pick<SubscriptionView, "amountMinor" | "currency" | "cycle">): string | null {
  if (s.amountMinor == null || !s.currency) return null;
  return `${formatMoney(s.amountMinor, s.currency)}${(s.cycle && CYCLE_SUFFIX[s.cycle]) || ""}`;
}

export function whenText(s: SubscriptionView): string {
  if (s.status === "canceled") return "Canceled";
  if (s.needsReview && s.reviewReason === "trial_outcome_unknown") return "Did this trial convert?";
  if (s.needsReview && s.reviewReason === "stale") return "Still subscribed?";
  if (s.needsReview) return "Please check the details";
  if (s.daysUntil == null) return s.status === "trial" ? "Trial" : "Next charge unknown";
  const verb = s.status === "trial" ? "Trial ends" : "Renews";
  if (s.daysUntil < 0) return `${verb} date passed`;
  if (s.daysUntil === 0) return `${verb} today`;
  if (s.daysUntil === 1) return `${verb} tomorrow`;
  if (s.daysUntil <= 14) return `${verb} in ${s.daysUntil} days`;
  const date = new Date(`${s.nextChargeDate}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `${verb} ${date}`;
}

function urgency(s: SubscriptionView): string {
  if (s.needsReview) return "text-warning";
  if (s.status === "canceled") return "text-muted";
  if (s.daysUntil != null && s.daysUntil >= 0 && s.daysUntil <= (s.status === "trial" ? 7 : 3)) return "text-danger";
  return "text-muted";
}

export function SubscriptionAvatar({ name, category, size = "size-11" }: { name: string; category: string; size?: string }) {
  return (
    <span
      className={`grid ${size} shrink-0 place-items-center rounded-xl text-base font-bold ${CATEGORY_TINT[category] ?? CATEGORY_TINT.other}`}
      aria-hidden
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

export function SubscriptionRowLink({ s }: { s: SubscriptionView }) {
  const p = price(s);
  return (
    <Link
      href={`/subscriptions/${s.id}`}
      className="flex items-center gap-3 rounded-xl px-3 py-3 transition hover:bg-canvas active:bg-brand-50"
    >
      <SubscriptionAvatar name={s.name} category={s.category} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate font-semibold">
          {s.name}
          {s.status === "trial" && (
            <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-700">TRIAL</span>
          )}
        </p>
        <p className={`text-sm ${urgency(s)}`}>{whenText(s)}</p>
      </div>
      <div className="text-right">
        <p className={`font-semibold tabular-nums ${s.status === "canceled" ? "text-muted line-through" : ""}`}>{p ?? "—"}</p>
        {s.plan && <p className="max-w-28 truncate text-xs text-muted">{s.plan}</p>}
      </div>
      <ChevronRight className="size-4 shrink-0 text-line" />
    </Link>
  );
}
