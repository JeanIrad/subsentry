import { CheckCircle2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Logo } from "@/components/logo";
import { button, card } from "@/components/ui";

export const metadata: Metadata = { title: "Account deleted", robots: { index: false } };

export default function GoodbyePage({ searchParams }: PageProps<"/goodbye">) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="pt-safe">
        <div className="mx-auto flex max-w-lg items-center px-5 py-4">
          <Logo />
        </div>
      </header>
      <main className="mx-auto w-full max-w-lg flex-1 px-4 pb-12">
        <section className={`${card} p-6 text-center`}>
          <CheckCircle2 className="mx-auto size-10 text-success" />
          <h1 className="mt-3 text-xl font-bold">Your account has been deleted</h1>
          <p className="mt-2 text-sm text-muted">
            We&apos;ve erased your subscriptions, reminders and everything else we stored. Thanks for trying SubSentry.
          </p>
          <Suspense>
            <GoogleNote searchParams={searchParams} />
          </Suspense>
          <Link href="/" className={`${button.secondary} mt-5 w-full`}>
            Back to the home page
          </Link>
        </section>
      </main>
    </div>
  );
}

async function GoogleNote({ searchParams }: { searchParams: PageProps<"/goodbye">["searchParams"] }) {
  const { google } = await searchParams;
  if (!google) return null;
  return (
    <p className="mt-4 rounded-xl bg-amber-50 p-3 text-left text-sm text-muted">
      We couldn&apos;t reach Google to finish cleaning up. To be sure, remove SubSentry at{" "}
      <a href="https://myaccount.google.com/permissions" className="font-semibold text-brand-600 underline">
        myaccount.google.com/permissions
      </a>{" "}
      and delete any leftover &ldquo;renews&rdquo; events in Google Calendar.
    </p>
  );
}
