import { ArrowRight, BellRing, CalendarCheck, Lock, Mail, ScanSearch, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { Logo } from "@/components/logo";
import { button, card } from "@/components/ui";
import { getOptionalUser } from "@/lib/auth";
import { SignInButton } from "./sign-in-button";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="pt-safe">
        <div className="mx-auto flex max-w-6xl items-center px-5 py-4">
          <Logo />
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="px-3 sm:px-5">
          <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[28px] bg-gradient-to-br from-brand-500 via-brand-600 to-brand-800 px-6 py-12 text-white sm:px-12 sm:py-16">
            <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-white/10" />
            <div aria-hidden className="pointer-events-none absolute -bottom-32 -left-16 size-80 rounded-full bg-brand-400/20" />

            <div className="relative grid items-center gap-12 lg:grid-cols-[1.1fr_0.9fr]">
              <div>
                <p className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-sm font-medium backdrop-blur">
                  <ShieldCheck className="size-4" /> Read-only · Free during beta
                </p>
                <h1 className="mt-5 text-4xl leading-[1.1] font-extrabold tracking-tight sm:text-5xl">
                  Never pay for a forgotten subscription again.
                </h1>
                <p className="mt-4 max-w-md text-lg text-brand-100">
                  SubSentry finds your subscriptions and free trials in Gmail and reminds you before
                  you&apos;re charged. No manual entry.
                </p>
                <div className="mt-8">
                  <Suspense fallback={<div className="h-[50px]" />}>
                    <AuthAction />
                  </Suspense>
                </div>
              </div>

              <ReminderPreview />
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="mx-auto max-w-6xl px-5 py-16">
          <h2 className="text-2xl font-bold tracking-tight">How it works</h2>
          <ol className="mt-6 grid gap-4 sm:grid-cols-3">
            <Step n={1} icon={<Mail />} title="Connect Gmail">
              One tap with Google. We only ever read, never send or delete.
            </Step>
            <Step n={2} icon={<ScanSearch />} title="We find everything">
              Receipts, renewals and trial sign-ups from the last 12 months, organised into one list.
            </Step>
            <Step n={3} icon={<BellRing />} title="Get reminded in time">
              Email and calendar alerts 14, 7 and 1 day before a charge, and before trials convert.
            </Step>
          </ol>
        </section>

        {/* Privacy */}
        <section className="mx-auto max-w-6xl px-5 pb-20">
          <div className={`${card} grid gap-6 p-6 sm:grid-cols-3 sm:p-8`}>
            <Pledge icon={<Lock />} title="Read-only access">
              Gmail permission is read-only. We can&apos;t send, change or delete anything.
            </Pledge>
            <Pledge icon={<ShieldCheck />} title="Your email stays yours">
              We keep only the details we extract, like price and renewal date. Never the email itself.
            </Pledge>
            <Pledge icon={<Trash2 />} title="Leave anytime">
              Disconnect and permanently delete all your data in one step.
            </Pledge>
          </div>
        </section>
      </main>

      <footer className="pb-safe border-t border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-6 text-sm text-muted">
          <span>SubSentry</span>
          <span>Made to save you money</span>
        </div>
      </footer>
    </div>
  );
}

async function AuthAction() {
  const user = await getOptionalUser();
  if (user) {
    return (
      <Link href="/dashboard" className={`${button.onBrand} w-full sm:w-auto`}>
        Open your dashboard <ArrowRight className="size-4" />
      </Link>
    );
  }
  return <SignInButton />;
}

/** Illustrative example of a reminder, so visitors see what they'll get. */
function ReminderPreview() {
  return (
    <div className="relative mx-auto w-full max-w-sm pb-8" aria-label="Example reminder">
      <div className="rotate-[-2deg] rounded-3xl bg-white p-5 text-ink shadow-2xl shadow-brand-950/30">
        <div className="flex items-center justify-between text-xs font-semibold text-muted">
          <span className="inline-flex items-center gap-1.5">
            <BellRing className="size-3.5 text-brand-600" /> Reminder
          </span>
          <span>Example</span>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-xl bg-brand-50 text-lg font-bold text-brand-700">
            S
          </div>
          <div className="flex-1">
            <p className="font-semibold">StreamPlus Premium</p>
            <p className="text-sm text-muted">Free trial ends in 3 days</p>
          </div>
          <p className="font-bold">$14.99</p>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 text-center text-sm font-semibold">
          <span className="rounded-lg bg-brand-50 py-2 text-brand-700">Keep</span>
          <span className="rounded-lg bg-red-50 py-2 text-danger">Cancel</span>
          <span className="rounded-lg bg-canvas py-2 text-muted">Not sure</span>
        </div>
      </div>
      <div className="absolute -bottom-1 -left-2 flex rotate-[3deg] items-center gap-2 rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-ink shadow-xl shadow-brand-950/20">
        <CalendarCheck className="size-4 text-brand-600" /> Added to your calendar
      </div>
    </div>
  );
}

function Step(props: { n: number; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className={`${card} p-6`}>
      <div className="flex items-center gap-3">
        <span className="grid size-11 place-items-center rounded-xl bg-brand-50 text-brand-600 [&>svg]:size-5">
          {props.icon}
        </span>
        <span className="text-sm font-semibold text-brand-600">Step {props.n}</span>
      </div>
      <h3 className="mt-4 text-lg font-bold">{props.title}</h3>
      <p className="mt-1 text-muted">{props.children}</p>
    </li>
  );
}

function Pledge(props: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-600 text-white [&>svg]:size-[18px]">
        {props.icon}
      </span>
      <div>
        <h3 className="font-bold">{props.title}</h3>
        <p className="mt-1 text-sm text-muted">{props.children}</p>
      </div>
    </div>
  );
}
