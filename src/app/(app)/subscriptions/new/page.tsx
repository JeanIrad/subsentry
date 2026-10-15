import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { card } from "@/components/ui";
import { addSubscription } from "../actions";
import { SubscriptionForm } from "../subscription-form";

export const metadata: Metadata = { title: "Add subscription" };

export default function NewSubscriptionPage() {
  return (
    <div className="flex flex-col gap-5">
      <Link href="/subscriptions" className="inline-flex items-center gap-1.5 self-start text-sm font-semibold text-brand-600">
        <ArrowLeft className="size-4" /> Subscriptions
      </Link>
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Add a subscription</h1>
        <p className="mt-1 text-sm text-muted">For anything we didn&apos;t find in your email.</p>
      </div>
      <section className={`${card} p-5`}>
        <SubscriptionForm
          action={addSubscription}
          submitLabel="Add subscription"
          defaults={{ name: "", plan: "", amount: "", currency: "USD", cycle: "monthly", nextChargeDate: "", status: "active" }}
        />
      </section>
    </div>
  );
}
