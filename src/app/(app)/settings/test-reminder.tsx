"use client";

import { Loader2, Send } from "lucide-react";
import { useActionState } from "react";
import { button } from "@/components/ui";
import { sendTestReminder, type TestEmailState } from "./actions";

export function TestReminderButton() {
  const [state, action, pending] = useActionState<TestEmailState>(sendTestReminder, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <button type="submit" disabled={pending} className={`${button.secondary} w-full sm:w-auto sm:self-start`}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        Send me a test reminder
      </button>
      {state.message && (
        <p role="status" className={`text-sm font-medium ${state.ok ? "text-success" : "text-danger"}`}>
          {state.message}
        </p>
      )}
    </form>
  );
}
