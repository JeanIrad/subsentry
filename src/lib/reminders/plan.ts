import { TZDate } from "@date-fns/tz";
import { addDays, format, parseISO } from "date-fns";
import { daysBetween, todayIn } from "@/lib/ledger/dates";

// Which reminders a subscription should have (SPEC §4.7, ARCHITECTURE §3.5).
// Pure: the reminders.plan job turns the result into rows.

export const PAID_OFFSETS = [14, 7, 1] as const;
export const TRIAL_OFFSETS = [7, 3, 1] as const;
/** Local time reminders go out. */
export const SEND_HOUR = 9;

export interface PlanInput {
  status: "trial" | "active" | "canceled" | "unknown";
  nextChargeDate: string | null;
  needsReview: boolean;
  quiet: boolean;
  dismissed: boolean;
  timezone: string;
  now: Date;
  /** Some reminder for this charge date already exists (sent or pending). */
  alreadyPlanned: boolean;
}

export interface PlannedReminder {
  /** The real expected charge date (unique key with offsetDays). */
  chargeDate: string;
  offsetDays: number;
  sendAt: Date;
}

export function isRemindable(i: Pick<PlanInput, "status" | "nextChargeDate" | "needsReview" | "quiet" | "dismissed">): boolean {
  return (i.status === "active" || i.status === "trial") && !!i.nextChargeDate && !i.needsReview && !i.quiet && !i.dismissed;
}

export function planReminders(i: PlanInput): PlannedReminder[] {
  if (!isRemindable(i) || !i.nextChargeDate) return [];
  const chargeDate = i.nextChargeDate;
  const today = todayIn(i.timezone, i.now);
  if (chargeDate < today) return [];

  // Trials often bill the evening before or early on the end date, so count
  // back from the day before; the "1 day" reminder then still arrives in time.
  const trial = i.status === "trial";
  const anchor = trial ? format(addDays(parseISO(chargeDate), -1), "yyyy-MM-dd") : chargeDate;
  const offsets = trial ? TRIAL_OFFSETS : PAID_OFFSETS;

  const planned: PlannedReminder[] = offsets
    .map((offsetDays) => ({ chargeDate, offsetDays, sendAt: at9am(addDaysIso(anchor, -offsetDays), i.timezone) }))
    .filter((r) => r.sendAt > i.now);

  // Found too late for any regular reminder (e.g. a trial discovered two days
  // before it ends): send one right away, unless we already reminded about it.
  if (planned.length === 0 && !i.alreadyPlanned) {
    planned.push({ chargeDate, offsetDays: Math.max(0, daysBetween(today, chargeDate)), sendAt: i.now });
  }
  return planned;
}

function addDaysIso(d: string, n: number): string {
  return format(addDays(parseISO(d), n), "yyyy-MM-dd");
}

function at9am(day: string, timezone: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(new TZDate(y, m - 1, d, SEND_HOUR, 0, timezone).getTime());
}
