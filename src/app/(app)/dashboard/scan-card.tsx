"use client";

import { AlertTriangle, Inbox, Loader2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { GoogleIcon } from "@/components/google-icon";
import { button } from "@/components/ui";
import { authClient } from "@/lib/auth/client";
import { startScan } from "./actions";

type Status = "pending" | "running" | "done" | "failed";

export function ScanCard(props: {
  status: Status | null;
  candidateCount: number | null;
  lastScanned: string | null;
  lastError: string | null;
  needsReconnect: boolean;
  /** Emails read by the AI so far vs. total candidates. */
  reading: { done: number; total: number };
  /** Services found so far (preview until the ledger lands in M3). */
  merchants: string[];
  /** Set while reading waits for the AI's daily free limit to reset. */
  pausedUntil: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const { status } = props;
  const busy = status === "running" || status === "pending" || isPending;
  const { done, total } = props.reading;
  const reading = status === "done" && done < total;

  // Poll while a scan is queued/running or emails are still being read.
  useEffect(() => {
    if (status !== "pending" && status !== "running" && !reading) return;
    const id = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(id);
  }, [status, reading, router]);

  const scan = () =>
    startTransition(async () => {
      await startScan();
      router.refresh();
    });

  const reconnect = () => authClient.linkSocial({ provider: "google", callbackURL: "/dashboard" });

  if (props.needsReconnect || status === "failed") {
    return (
      <section className="rounded-3xl border border-amber-200 bg-amber-50 p-6">
        <div className="flex items-start gap-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-amber-100 text-warning">
            <AlertTriangle className="size-5" />
          </span>
          <div className="flex-1">
            <h2 className="font-bold">We couldn&apos;t finish scanning</h2>
            <p className="mt-1 text-sm text-muted">{props.lastError ?? "Something went wrong. Please try again."}</p>
            <div className="mt-4">
              {props.needsReconnect ? (
                <button type="button" onClick={reconnect} className={button.secondary}>
                  <GoogleIcon className="size-4" /> Reconnect Google
                </button>
              ) : (
                <button type="button" onClick={scan} disabled={busy} className={button.secondary}>
                  <RefreshCw className="size-4" /> Try again
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-500 via-brand-600 to-brand-800 p-6 text-white shadow-lift sm:p-8">
      <div aria-hidden className="pointer-events-none absolute -top-20 -right-16 size-56 rounded-full bg-white/10" />
      <div aria-hidden className="pointer-events-none absolute -bottom-24 left-1/3 size-56 rounded-full bg-brand-400/20" />

      <div className="relative">
        <p className="inline-flex items-center gap-2 text-sm font-semibold text-brand-100">
          <Inbox className="size-4" /> Inbox scan
        </p>

        {reading ? (
          <>
            <h2 className="mt-3 text-2xl font-bold">{props.pausedUntil ? "Taking a short break" : "Reading your emails…"}</h2>
            <p className="mt-1 text-brand-100">
              {done.toLocaleString("en-US")} of {total.toLocaleString("en-US")} read.{" "}
              {props.pausedUntil
                ? `We've hit today's free AI limit and will pick up again around ${props.pausedUntil}.`
                : "You can leave this page; we'll keep going."}
            </p>
            <div
              className="mt-5 h-2 w-full max-w-sm overflow-hidden rounded-full bg-white/20"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={done}
            >
              <div
                className="h-full rounded-full bg-white transition-[width] duration-700"
                style={{ width: `${Math.max(4, (done / Math.max(1, total)) * 100)}%` }}
              />
            </div>
          </>
        ) : status === "done" && props.candidateCount != null ? (
          <>
            <p className="mt-3 flex items-baseline gap-2">
              <span className="text-5xl font-extrabold tracking-tight tabular-nums">
                {props.candidateCount.toLocaleString("en-US")}
              </span>
              <span className="text-lg font-semibold text-brand-100">emails found</span>
            </p>
            <p className="mt-1 max-w-md text-brand-100">
              that look like receipts, renewals or trial notices from the last 12 months.
            </p>
          </>
        ) : busy ? (
          <>
            <h2 className="mt-3 text-2xl font-bold">Scanning your inbox…</h2>
            <p className="mt-1 text-brand-100">Looking for receipts, renewals and free trials. This takes about a minute.</p>
            <div className="mt-5 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-white/20">
              <div className="h-full w-1/3 animate-scan rounded-full bg-white" />
            </div>
          </>
        ) : (
          <>
            <h2 className="mt-3 text-2xl font-bold">Let&apos;s find your subscriptions</h2>
            <p className="mt-1 max-w-md text-brand-100">
              We&apos;ll look through the last 12 months of email for receipts, renewals and trials.
            </p>
          </>
        )}

        {props.merchants.length > 0 && (
          <div className="mt-6">
            <p className="text-xs font-semibold tracking-wide text-brand-100 uppercase">Found so far</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {props.merchants.map((m) => (
                <li key={m} className="rounded-full bg-white/15 px-3 py-1 text-sm font-semibold backdrop-blur">
                  {m}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3">
          <button type="button" onClick={scan} disabled={busy || reading} className={`${button.onBrand} w-full sm:w-auto`}>
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Scanning…
              </>
            ) : status === "done" ? (
              <>
                <RefreshCw className="size-4" /> Scan again
              </>
            ) : (
              "Scan my inbox"
            )}
          </button>
          {status === "done" && props.lastScanned && (
            <span className="text-sm text-brand-100">Last scanned {props.lastScanned}</span>
          )}
        </div>
      </div>
    </section>
  );
}
