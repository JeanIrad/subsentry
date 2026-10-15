"use client";

import { Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { useFormStatus } from "react-dom";
import { button } from "@/components/ui";
import { deleteMyAccount } from "./actions";

export function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={`${button.danger} w-full sm:w-auto`}>
        <Trash2 className="size-4" /> Delete account &amp; data
      </button>
    );
  }
  return (
    <form action={deleteMyAccount} className="flex w-full flex-col gap-3 rounded-2xl border border-red-200 bg-red-50 p-4">
      <p className="text-sm font-semibold text-danger">This can&apos;t be undone.</p>
      <p className="text-sm text-muted">
        We&apos;ll remove the calendar events we created, revoke SubSentry&apos;s access to your Google account, and
        permanently erase your subscriptions, reminders and everything else we stored.
      </p>
      <label className="flex flex-col gap-1.5 text-sm font-semibold">
        Type DELETE to confirm
        <input
          name="confirm"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          className="rounded-xl border border-line bg-surface px-3.5 py-3 text-[15px] font-normal outline-none focus:border-red-400 focus:ring-4 focus:ring-red-100"
        />
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Submit enabled={typed === "DELETE"} />
        <button type="button" onClick={() => setOpen(false)} className={`${button.secondary} w-full sm:w-auto`}>
          Keep my account
        </button>
      </div>
    </form>
  );
}

function Submit({ enabled }: { enabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={!enabled || pending}
      className={`${button.primary} w-full !bg-danger hover:!bg-red-700 sm:w-auto`}
    >
      {pending && <Loader2 className="size-4 animate-spin" />}
      Delete everything
    </button>
  );
}
