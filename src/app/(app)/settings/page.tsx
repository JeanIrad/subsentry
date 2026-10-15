import { and, eq } from "drizzle-orm";
import { BellRing, CheckCircle2, Globe, Smartphone, TriangleAlert, UserRound } from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import { Suspense, type ReactNode } from "react";
import { GoogleIcon } from "@/components/google-icon";
import { button, card } from "@/components/ui";
import { db } from "@/db/client";
import { accounts, gmailSyncState } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { CALENDAR_EVENTS, GMAIL_READONLY } from "@/lib/google/auth";
import { InstallApp } from "./install-app";
import { SignOutButton } from "./sign-out-button";
import { TestReminderButton } from "./test-reminder";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Settings</h1>
      <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-line/70" />}>
        <SettingsContent />
      </Suspense>
    </div>
  );
}

async function SettingsContent() {
  const user = await requireUser();
  const [[account], [sync]] = await Promise.all([
    db
      .select({ scope: accounts.scope })
      .from(accounts)
      .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, "google")))
      .limit(1),
    db
      .select({ disconnectedAt: gmailSyncState.disconnectedAt })
      .from(gmailSyncState)
      .where(eq(gmailSyncState.userId, user.id))
      .limit(1),
  ]);
  const granted = new Set((account?.scope ?? "").split(/[ ,]+/));
  const connected = sync?.disconnectedAt == null;

  return (
    <div className="flex flex-col gap-6">
      <section className={`${card} flex items-center gap-4 p-5`}>
        {user.image ? (
          <Image src={user.image} alt="" width={56} height={56} className="size-14 rounded-full" unoptimized referrerPolicy="no-referrer" />
        ) : (
          <span className="grid size-14 place-items-center rounded-full bg-brand-100 text-xl font-bold text-brand-700">
            {user.name.charAt(0).toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <p className="truncate text-lg font-bold">{user.name}</p>
          <p className="truncate text-sm text-muted">{user.email}</p>
          <p className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-muted">
            <Globe className="size-3.5" /> {user.timezone ?? "UTC"}
          </p>
        </div>
      </section>

      <Section title="Google connection" icon={<GoogleIcon className="size-5" />}>
        <ul className="flex flex-col divide-y divide-line">
          <Permission ok={connected && granted.has(GMAIL_READONLY)} label="Gmail" detail="Read-only. We can't send or delete email." />
          <Permission
            ok={connected && granted.has(CALENDAR_EVENTS)}
            label="Google Calendar"
            detail="Adds an event before each upcoming charge."
          />
        </ul>
      </Section>

      <Section title="Reminders" icon={<BellRing className="size-5 text-brand-600" />}>
        <p className="mb-4 text-sm text-muted">
          We email you at 9:00 your time 14, 7 and 1 days before a renewal, and 7, 3 and 1 days before a free trial
          ends, and add an event with matching alerts to your Google Calendar. Turn reminders off for any subscription
          from its page.
        </p>
        <TestReminderButton />
      </Section>

      <Section title="Get the app" icon={<Smartphone className="size-5 text-brand-600" />}>
        <p className="mb-4 text-sm text-muted">
          Add SubSentry to your home screen. It opens full-screen like any other app.
        </p>
        <InstallApp />
      </Section>

      <Section title="Account" icon={<UserRound className="size-5 text-brand-600" />}>
        <div className="flex flex-col gap-3 sm:flex-row">
          <SignOutButton />
          <button type="button" disabled className={`${button.danger} w-full sm:w-auto`} title="Coming soon">
            Delete account &amp; data
          </button>
        </div>
        <p className="mt-3 text-xs text-muted">
          Deleting will revoke Google access and permanently erase everything we&apos;ve stored. Coming soon.
        </p>
      </Section>
    </div>
  );
}

function Section(props: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className={`${card} p-5 sm:p-6`}>
      <h2 className="mb-4 flex items-center gap-2.5 font-bold">
        {props.icon}
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

function Permission(props: { ok: boolean; label: string; detail: string }) {
  return (
    <li className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      {props.ok ? (
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
      ) : (
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" />
      )}
      <div>
        <p className="text-sm font-semibold">
          {props.label} <span className="font-normal text-muted">· {props.ok ? "Connected" : "Not granted"}</span>
        </p>
        <p className="text-sm text-muted">{props.detail}</p>
      </div>
    </li>
  );
}
