import { and, count, eq, gte, ne, sql } from "drizzle-orm";
import { BellRing, Check, ChevronRight, CircleHelp, Inbox, ListChecks, Mail, Plus, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { SubscriptionRowLink } from "@/components/subscription-row";
import { button, card } from "@/components/ui";
import { db } from "@/db/client";
import { extractions, gmailSyncState, processedMessages } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { formatMoney } from "@/lib/money";
import { computeTotals, listSubscriptions, type Totals } from "@/lib/subscriptions/queries";
import { ScanCard } from "./scan-card";
import { TimezoneSync } from "./timezone-sync";

export const metadata: Metadata = { title: "Home" };

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <Dashboard />
    </Suspense>
  );
}

async function Dashboard() {
  const user = await requireUser();
  const timezone = user.timezone ?? "UTC";
  const [[sync], statusCounts, merchantRows] = await Promise.all([
    db.select().from(gmailSyncState).where(eq(gmailSyncState.userId, user.id)).limit(1),
    db
      .select({ status: processedMessages.status, n: count() })
      .from(processedMessages)
      .where(eq(processedMessages.userId, user.id))
      .groupBy(processedMessages.status),
    db
      .selectDistinct({ merchant: sql<string>`${extractions.payload}->>'merchant'` })
      .from(extractions)
      .where(
        and(
          eq(extractions.userId, user.id),
          ne(extractions.kind, "not_subscription"),
          gte(extractions.confidence, 0.6),
          sql`${extractions.payload}->>'merchant' IS NOT NULL`,
        ),
      )
      .limit(24),
  ]);
  const total = statusCounts.reduce((sum, r) => sum + r.n, 0);
  const queued = statusCounts.find((r) => r.status === "queued")?.n ?? 0;
  const reading = { done: total - queued, total };
  const merchants = merchantRows.map((r) => r.merchant).sort((a, b) => a.localeCompare(b));

  const firstName = user.name.split(" ")[0] || "there";
  const scanned = sync?.backfillStatus === "done";
  const analysed = scanned && total > 0 && queued === 0;
  // Formatted on the server in the user's timezone to avoid hydration mismatches.
  const pausedUntil =
    sync?.extractPausedUntil && sync.extractPausedUntil > new Date()
      ? new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: timezone }).format(
          sync.extractPausedUntil,
        )
      : null;
  const lastScanned = sync?.lastSyncedAt
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(
        sync.lastSyncedAt,
      )
    : null;

  const subs = (await listSubscriptions(user.id, timezone)).filter((x) => !x.dismissed);
  const totals = computeTotals(subs);
  const toReview = subs.filter((x) => x.needsReview && x.status !== "canceled");
  const upcoming = subs
    .filter((x) => !x.needsReview && (x.status === "active" || x.status === "trial") && x.daysUntil != null && x.daysUntil >= 0)
    .slice(0, 5);
  const trials = subs.filter((x) => x.status === "trial" && !x.needsReview).length;

  const scanCard = (
    <ScanCard
      status={sync?.backfillStatus ?? null}
      candidateCount={sync?.candidateCount ?? null}
      lastScanned={lastScanned}
      lastError={sync?.lastError ?? null}
      needsReconnect={sync?.disconnectedAt != null}
      reading={reading}
      merchants={subs.length > 0 ? [] : merchants}
      pausedUntil={pausedUntil}
    />
  );

  return (
    <div className="flex flex-col gap-6">
      <TimezoneSync current={timezone} />

      <div>
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Hi, {firstName}</h1>
        <p className="mt-1 text-muted">
          {subs.length > 0 ? "Here's where your money goes each month." : "Here's what SubSentry has found in your inbox."}
        </p>
      </div>

      {subs.length === 0 ? (
        <>
          {scanCard}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <section className={`${card} p-5 sm:p-6`}>
              <h2 className="font-bold">Getting set up</h2>
              <ol className="mt-4 flex flex-col gap-1">
                <SetupStep state="done" icon={<Mail />} title="Connect Gmail" detail="Read-only access granted" />
                <SetupStep
                  state={scanned ? "done" : "current"}
                  icon={<Inbox />}
                  title="Scan your inbox"
                  detail={scanned ? "Receipts and notices found" : "Looking back 12 months"}
                />
                <SetupStep
                  state={analysed ? "done" : scanned ? "current" : "todo"}
                  icon={<Sparkles />}
                  title="Identify subscriptions"
                  detail={scanned && !analysed ? `Reading emails: ${reading.done} of ${reading.total}` : "We read each email and pull out the details"}
                />
                <SetupStep state="todo" icon={<BellRing />} title="Reminders on" detail="Email + calendar alerts before charges" />
              </ol>
            </section>
            <section className={`${card} flex flex-col items-center justify-center p-8 text-center`}>
              <span className="grid size-14 place-items-center rounded-2xl bg-brand-50 text-brand-600">
                <ListChecks className="size-7" />
              </span>
              <h2 className="mt-4 text-lg font-bold">
                {analysed ? "No subscriptions found" : "Your subscriptions will appear here"}
              </h2>
              <p className="mt-1 max-w-sm text-sm text-muted">
                {analysed
                  ? "We didn't find any subscription emails. You can add one yourself."
                  : "Once we've read your receipts you'll see every subscription and trial, what each costs, and when it renews."}
              </p>
              {analysed && (
                <Link href="/subscriptions/new" className={`${button.secondary} mt-4`}>
                  <Plus className="size-4" /> Add a subscription
                </Link>
              )}
            </section>
          </div>
        </>
      ) : (
        <>
          <SpendCard totals={totals} active={subs.filter((x) => x.status === "active").length} trials={trials} />

          {toReview.length > 0 && (
            <Link
              href="/subscriptions"
              className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 transition hover:bg-amber-100/60"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-100 text-warning">
                <CircleHelp className="size-5" />
              </span>
              <span className="flex-1">
                <span className="block font-semibold">
                  {toReview.length} {toReview.length === 1 ? "subscription needs" : "subscriptions need"} a quick check
                </span>
                <span className="block text-sm text-muted">Confirm them so we can remind you in time.</span>
              </span>
              <ChevronRight className="size-5 text-muted" />
            </Link>
          )}

          <section className={`${card} p-2`}>
            <div className="flex items-center justify-between px-3 pt-3 pb-1">
              <h2 className="font-bold">Coming up</h2>
              <Link href="/subscriptions" className="text-sm font-semibold text-brand-600">
                See all
              </Link>
            </div>
            {upcoming.length > 0 ? (
              <ul className="divide-y divide-line">
                {upcoming.map((x) => (
                  <li key={x.id}>
                    <SubscriptionRowLink s={x} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-6 text-center text-sm text-muted">No upcoming charges we know of.</p>
            )}
          </section>

          {scanCard}
        </>
      )}
    </div>
  );
}

function SpendCard({ totals, active, trials }: { totals: Totals[]; active: number; trials: number }) {
  const [main, ...others] = totals;
  return (
    <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-500 via-brand-600 to-brand-800 p-6 text-white shadow-lift sm:p-8">
      <div aria-hidden className="pointer-events-none absolute -top-20 -right-16 size-56 rounded-full bg-white/10" />
      <div className="relative">
        <p className="text-sm font-semibold text-brand-100">Monthly spend</p>
        {main ? (
          <>
            <p className="mt-1 text-5xl font-extrabold tracking-tight tabular-nums">{formatMoney(main.monthlyMinor, main.currency)}</p>
            <p className="mt-1 text-brand-100">
              {formatMoney(main.yearlyMinor, main.currency)} a year
              {others.map((o) => ` · ${formatMoney(o.monthlyMinor, o.currency)}/mo in ${o.currency}`).join("")}
            </p>
          </>
        ) : (
          <p className="mt-1 text-2xl font-bold">Nothing confirmed yet</p>
        )}
        <div className="mt-5 flex flex-wrap gap-2 text-sm font-semibold">
          <span className="rounded-full bg-white/15 px-3 py-1">{active} active</span>
          {trials > 0 && <span className="rounded-full bg-white/15 px-3 py-1">{trials} free {trials === 1 ? "trial" : "trials"}</span>}
        </div>
      </div>
    </section>
  );
}

function SetupStep(props: { state: "done" | "current" | "todo"; icon: ReactNode; title: string; detail: string }) {
  const { state } = props;
  return (
    <li className={`flex items-center gap-3 rounded-xl p-2.5 ${state === "current" ? "bg-brand-50" : ""}`}>
      <span
        className={`grid size-9 shrink-0 place-items-center rounded-full [&>svg]:size-4 ${
          state === "done"
            ? "bg-brand-600 text-white"
            : state === "current"
              ? "bg-white text-brand-600 ring-2 ring-brand-200"
              : "bg-canvas text-muted"
        }`}
      >
        {state === "done" ? <Check strokeWidth={3} /> : props.icon}
      </span>
      <div className="min-w-0">
        <p className={`text-sm font-semibold ${state === "todo" ? "text-muted" : ""}`}>{props.title}</p>
        <p className="text-xs text-muted">{props.detail}</p>
      </div>
    </li>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-6" aria-busy="true" aria-label="Loading">
      <div className="h-9 w-48 rounded-lg bg-line" />
      <div className="h-48 rounded-3xl bg-brand-100" />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="h-64 rounded-2xl bg-line/70" />
        <div className="h-64 rounded-2xl bg-line/70" />
      </div>
    </div>
  );
}
