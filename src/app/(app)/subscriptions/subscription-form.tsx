"use client";

import { Loader2 } from "lucide-react";
import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { button } from "@/components/ui";
import type { FormState } from "./actions";

export interface FormDefaults {
  name: string;
  plan: string;
  amount: string;
  currency: string;
  cycle: string;
  nextChargeDate: string;
  status: string;
}

const input =
  "w-full rounded-xl border border-line bg-surface px-3.5 py-3 text-[15px] text-ink outline-none transition placeholder:text-muted/60 focus:border-brand-400 focus:ring-4 focus:ring-brand-100";

export function SubscriptionForm(props: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  defaults: FormDefaults;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(props.action, {});
  const [saved, setSaved] = useState(false);
  const submitted = useRef(false);
  const e = state.fieldErrors ?? {};

  // Brief "Saved" confirmation after a successful edit.
  useEffect(() => {
    if (!submitted.current || pending || state.fieldErrors || state.error) return;
    submitted.current = false;
    queueMicrotask(() => setSaved(true));
    const t = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(t);
  }, [pending, state]);

  return (
    <form action={formAction} onSubmit={() => (submitted.current = true)} className="flex flex-col gap-4" noValidate>
      <Field label="Name" error={e.name}>
        <input name="name" defaultValue={props.defaults.name} required maxLength={100} className={input} placeholder="Netflix" />
      </Field>
      <Field label="Plan (optional)">
        <input name="plan" defaultValue={props.defaults.plan} maxLength={100} className={input} placeholder="Standard" />
      </Field>
      <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
        <Field label="Price" error={e.amount}>
          <input name="amount" defaultValue={props.defaults.amount} inputMode="decimal" className={input} placeholder="11.99" />
        </Field>
        <Field label="Currency" error={e.currency}>
          <input
            name="currency"
            defaultValue={props.defaults.currency}
            maxLength={3}
            autoCapitalize="characters"
            className={`${input} uppercase`}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Billed">
          <select name="cycle" defaultValue={props.defaults.cycle} className={input}>
            <option value="">Not sure</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Every 3 months</option>
            <option value="yearly">Yearly</option>
            <option value="other">Other</option>
          </select>
        </Field>
        <Field label="Status">
          <select name="status" defaultValue={props.defaults.status} className={input}>
            <option value="active">Active</option>
            <option value="trial">Free trial</option>
            <option value="canceled">Canceled</option>
            <option value="unknown">Not sure</option>
          </select>
        </Field>
      </div>
      <Field label="Next charge" error={e.nextChargeDate}>
        <input type="date" name="nextChargeDate" defaultValue={props.defaults.nextChargeDate} className={input} />
      </Field>

      {state.error && <p className="text-sm font-medium text-danger">{state.error}</p>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={`${button.primary} w-full sm:w-auto`}>
          {pending && <Loader2 className="size-4 animate-spin" />}
          {props.submitLabel}
        </button>
        {saved && <span className="text-sm font-semibold text-success">Saved</span>}
      </div>
    </form>
  );
}

function Field(props: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-semibold">{props.label}</span>
      {props.children}
      {props.error && <span className="text-sm font-medium text-danger">{props.error}</span>}
    </label>
  );
}
