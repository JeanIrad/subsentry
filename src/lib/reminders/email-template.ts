import { formatMoney } from "@/lib/money";

// Reminder email (SPEC FR-12). Plain HTML with inline styles: email clients
// ignore <style> blocks and external CSS. Every dynamic value is escaped —
// merchant names and plans come from an LLM reading untrusted email.

export interface ReminderEmailInput {
  merchantName: string;
  planName: string | null;
  status: "trial" | "active";
  amountMinor: number | null;
  currency: string | null;
  cycle: string | null;
  chargeDate: string;
  daysLeft: number;
  priceChanged: boolean;
  cancelUrl: string | null;
  detailUrl: string;
}

const CYCLE: Record<string, string> = { weekly: "week", monthly: "month", quarterly: "quarter", yearly: "year" };

export function renderReminderEmail(i: ReminderEmailInput): { subject: string; html: string; text: string } {
  const price = i.amountMinor != null && i.currency ? formatMoney(i.amountMinor, i.currency) : null;
  const per = i.cycle && CYCLE[i.cycle] ? `/${CYCLE[i.cycle]}` : "";
  const when = i.daysLeft <= 0 ? "today" : i.daysLeft === 1 ? "tomorrow" : `in ${i.daysLeft} days`;
  const date = new Date(`${i.chargeDate}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  const trial = i.status === "trial";

  const subject = trial
    ? `Your ${i.merchantName} free trial ends ${when}${price ? ` (then ${price}${per})` : ""}`
    : `${i.merchantName} renews ${when}${price ? ` for ${price}` : ""}`;
  const headline = trial ? `Your free trial ends ${when}` : `Renews ${when}`;
  const lead = trial
    ? `After ${date}, ${price ? `you'll be charged ${price}${per}` : "you'll start being charged"} unless you cancel before then.`
    : `${price ? `You'll be charged ${price}` : "You'll be charged"} on ${date}.`;

  const rows: [string, string][] = [
    ["Service", i.merchantName + (i.planName ? ` · ${i.planName}` : "")],
    [trial ? "Price after trial" : "Amount", price ? `${price}${per}${i.priceChanged ? " (new price)" : ""}` : "Unknown"],
    [trial ? "Trial ends" : "Charge date", date],
  ];

  const e = escapeHtml;
  const button = (href: string, label: string, primary: boolean) =>
    `<a href="${e(href)}" style="display:inline-block;padding:12px 20px;border-radius:12px;font-weight:600;font-size:15px;text-decoration:none;${
      primary ? "background:#2453e0;color:#ffffff;" : "background:#ffffff;color:#1c41bd;border:1px solid #bfd5ff;"
    }">${e(label)}</a>`;

  const html = `<!doctype html>
<html><body style="margin:0;background:#f4f7fd;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0e1a3a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fd;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
  <tr><td style="padding:0 4px 16px;font-weight:700;font-size:17px;color:#1c41bd;">🛡️ SubSentry</td></tr>
  <tr><td style="background:linear-gradient(135deg,#3b6ef2,#1c41bd);background-color:#2453e0;border-radius:20px;padding:28px 24px;color:#ffffff;">
    <div style="font-size:14px;font-weight:600;color:#dbe8ff;">${e(i.merchantName)}</div>
    <div style="font-size:26px;font-weight:800;margin-top:6px;line-height:1.2;">${e(headline)}</div>
    <div style="font-size:15px;margin-top:8px;color:#dbe8ff;line-height:1.5;">${e(lead)}</div>
  </td></tr>
  <tr><td style="height:12px;"></td></tr>
  <tr><td style="background:#ffffff;border:1px solid #e2e9f6;border-radius:20px;padding:8px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${rows
        .map(
          ([k, v], idx) =>
            `<tr><td style="padding:12px 0;font-size:14px;color:#5a6888;${idx ? "border-top:1px solid #e2e9f6;" : ""}">${e(k)}</td><td align="right" style="padding:12px 0;font-size:15px;font-weight:600;${idx ? "border-top:1px solid #e2e9f6;" : ""}">${e(v)}</td></tr>`,
        )
        .join("")}
    </table>
  </td></tr>
  <tr><td style="padding:20px 0 4px;">
    ${i.cancelUrl ? `${button(i.cancelUrl, `Manage or cancel on ${i.merchantName}`, true)}&nbsp;&nbsp;` : ""}${button(i.detailUrl, "Open in SubSentry", !i.cancelUrl)}
  </td></tr>
  <tr><td style="padding:24px 4px 0;font-size:12px;color:#5a6888;line-height:1.6;">
    You're getting this because SubSentry found this ${trial ? "trial" : "subscription"} in your email.
    Not right, or don't want reminders for it? <a href="${e(i.detailUrl)}" style="color:#2453e0;">Update it in SubSentry</a>.
  </td></tr>
</table></td></tr></table>
</body></html>`;

  const text = [
    `${i.merchantName}: ${headline}`,
    lead,
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    i.cancelUrl ? `Manage or cancel: ${i.cancelUrl}` : null,
    `Open in SubSentry: ${i.detailUrl}`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  return { subject: subject.replace(/[\r\n]+/g, " "), html, text };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
