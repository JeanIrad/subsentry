import { Resend } from "resend";

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Same key → Resend sends at most once (24h), even if we retry after a crash. */
  idempotencyKey: string;
}

/** Mocked in tests. */
export interface EmailSender {
  send(email: OutgoingEmail): Promise<{ id: string }>;
}

/** Retrying won't help (bad address, unverified recipient, bad key). */
export class EmailPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailPermanentError";
  }
}

export function createResendSender(opts: { apiKey: string; from: string }): EmailSender {
  const resend = new Resend(opts.apiKey);
  return {
    async send({ to, subject, html, text, idempotencyKey }) {
      const { data, error } = await resend.emails.send({ from: opts.from, to, subject, html, text }, { idempotencyKey });
      if (error) {
        // 4xx other than rate limiting won't succeed on retry. Resend's free
        // tier without a verified domain only delivers to the account owner.
        const status = (error as { statusCode?: number | null }).statusCode ?? 0;
        if (status >= 400 && status < 500 && status !== 429) throw new EmailPermanentError(error.message);
        throw new Error(`Resend error: ${error.message}`);
      }
      if (!data) throw new Error("Resend returned no data");
      return { id: data.id };
    },
  };
}
