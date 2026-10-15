# SubSentry — Architecture (MVP)

See `SPEC.md` for product scope. This document covers how the MVP is built.

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | One language for web, API, and jobs |
| Runtime | Node.js 24 LTS | Native TS-friendly tooling; required by pg-boss 12 |
| Web + API | Next.js 16 (App Router) + React 19 + Tailwind 4 | UI + route handlers in one deployable |
| Auth | Better Auth (Google provider, Drizzle adapter) | Google sign-in and Gmail/Calendar consent in one flow; built-in encrypted token storage and server-side token refresh the worker can call. Chosen over Auth.js, whose v5 never left beta and is now in maintenance mode |
| Database | PostgreSQL 17 | Relational ledger; JSONB for raw extractions |
| ORM | Drizzle (`node-postgres` driver) | Typed schema + migrations; same `pg` driver as pg-boss |
| Background jobs | pg-boss 12 (Postgres-backed queue) | No extra infra; retries, cron schedules, singleton/stately queues |
| LLM | Provider-agnostic `StructuredLLM` (`src/lib/llm/`); currently Gemini via `@google/genai` (`EXTRACT_MODEL`, default `gemini-flash-latest`) with JSON-schema output | Cheap structured extraction. **Dev uses the free AI Studio tier, under which Google may use requests to improve its models, so it is only for the developer's own test inboxes. Switch to a paid key (or Vertex AI) before onboarding any other user**: Google's Gmail data policy forbids using that data to train general AI models. Adding another provider = one file + an `LLM_PROVIDER` value |
| HTML → text | `html-to-text` | Receipts are mostly HTML tables |
| Validation | Zod 4 | Validates LLM JSON, env, and API inputs |
| Email delivery | Resend + React Email | Simple transactional email API, templates as TSX |
| Google APIs | `@googleapis/gmail`, `@googleapis/calendar` | Per-API packages instead of the very large `googleapis` bundle |
| Dates | date-fns 4 + `@date-fns/tz` | First-party timezone support (`TZDate`) |
| Tests | Vitest + fixture-based extraction evals | |
| Mobile | Installable PWA (`app/manifest.ts`, icons from `scripts/icon.svg` via `npm run icons`) | One codebase for web + phone; web push works on Android and on iOS 16.4+ once installed, so push can become a reminder channel without app stores |
| UI | Tailwind 4 tokens in `globals.css` (blue & white), Plus Jakarta Sans, lucide-react icons; shared classes in `src/components/ui.ts` | Mobile-first: bottom tab bar on phones, top nav ≥ 640px |
| Local dev | Docker Compose (Postgres), `tsx` for the worker | |

Deployment target (later): Vercel or Fly.io for web, a separate long-running worker process for pg-boss, managed Postgres (Neon/Supabase/RDS).

## 2. System overview

```
┌──────────────┐   OAuth    ┌──────────────────┐
│   Browser    │──────────▶ │  Next.js app     │
│  (dashboard) │ ◀───────── │  UI + API routes │
└──────────────┘            └────────┬─────────┘
                                     │ enqueue jobs / read+write
                                     ▼
                            ┌──────────────────┐
                            │    PostgreSQL    │◀────────┐
                            │ data + pg-boss   │         │
                            └────────┬─────────┘         │
                                     │ jobs              │
                                     ▼                   │
                            ┌──────────────────┐         │
                            │  Worker process  │─────────┘
                            │  (pg-boss)       │
                            └─┬──────┬──────┬──┘
                              │      │      │
                   Gmail API ◀┘      │      └▶ Resend (email)
                                     ▼
                              Claude API      Google Calendar API
```

## 3. Pipeline

### 3.1 Connect
1. User signs in with Google. Scopes: `openid email profile`, `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/calendar.events`.
   Requested with `access_type=offline` and `prompt=consent` so Google always returns a refresh token.
2. Better Auth stores access + refresh tokens in `accounts`, encrypted (`account.encryptOAuthTokens`, XChaCha20-Poly1305 keyed from `BETTER_AUTH_SECRET`). Code gets a fresh access token through `getGoogleAccessToken(userId)` (wraps `auth.api.getAccessToken`, which refreshes when expired).
3. Capture the browser's IANA timezone into `users.timezone`.
4. Enqueue `gmail.backfill` from Better Auth's `account.create.after` hook (not `user.create`: the user row is written before the tokens, so a user-hook job could race them). The dashboard's "Scan inbox" button enqueues it too.

### 3.2 Fetch (`gmail.backfill`, `gmail.sync`)
- Backfill: Gmail `users.messages.list` (500/page) with a pre-filter query over the last 12 months, built by `src/lib/google/backfill-query.ts`:
  ```
  newer_than:365d (subject:(receipt OR invoice OR subscription OR "free trial" OR renewal OR …)
    OR (from:(netflix.com OR spotify.com OR …) (subscription OR membership OR billing OR payment OR …)))
    -category:social -category:forums -in:chats
  ```
  Sender-only matches must also contain a billing term, so "New on Netflix" marketing doesn't reach the LLM. Broad senders (google.com, amazon.com, apple.com) are deliberately not in `src/lib/google/known-senders.ts`; their receipts match on subject.
- The mailbox `historyId` is captured before listing (first run only) so incremental sync can't miss mail that arrives mid-backfill.
- Message IDs are inserted into `processed_messages` (`ON CONFLICT DO NOTHING`), which is the source of truth. Every row still `queued` on the page is (re-)enqueued; this also repairs a crash between insert and enqueue.
- Incremental (`gmail.sync`, fanned out to every connected user by the `gmail.sync.all` cron every 4 hours): re-runs the same candidate query over the days since `last_synced_at` + 2 days of margin (capped at 365). Already-seen IDs are skipped by `processed_messages`, so the overlap is free and downtime of any length is covered. This replaced the planned `users.history.list` approach, which needs an expiry fallback anyway and saves nothing at our volume; `history_id` is still recorded. Skipped until the first backfill is `done`, and for disconnected accounts.
- `email.extract` uses a `stately` queue with `singletonKey = userId:messageId`, so re-enqueueing a message that's already queued is a no-op.
- LLM quota: a 429 with a short `retryDelay` pauses the pacer and retries; a long one (e.g. the free tier's daily cap) re-enqueues the job with `startAfter` and sets `gmail_sync_state.extract_paused_until` so the dashboard can say when reading resumes.
- Failures: `GoogleReconnectRequiredError` (no account, scope not granted, no refresh token) sets `last_error` + `disconnected_at` and does not retry; the dashboard shows "Reconnect Google". Other errors set a generic `last_error` and rethrow for pg-boss retry.

### 3.3 Extract (`email.extract`)
1. Skip unless `processed_messages.status = 'queued'` (idempotency). Fetch the message (`format=full`); use text/plain unless it's a stub, else HTML → text; strip quoted replies and long tracking URLs; truncate to 24k chars (~6k tokens).
2. Wait for the worker's pacer (`LLM_MIN_INTERVAL_MS`, plus any `retryDelay` from a 429), then call the LLM with the system prompt in `src/lib/extract/prompt.ts` and the JSON schema generated from the Zod schema (`src/lib/extract/schema.ts`). The email body is wrapped in `<email_body>` and marked as data, not instructions. `email.extract` runs one job at a time. Output schema:
   ```ts
   {
     kind: "receipt" | "renewal_notice" | "trial_started" | "trial_ending"
         | "cancellation_confirmation" | "price_change" | "not_subscription",
     merchant: string | null,          // display name, e.g. "Spotify"
     plan: string | null,              // e.g. "Premium Individual"
     amount: number | null,            // in major units; converted to integer minor units by src/lib/money.ts right after validation
     currency: string | null,          // ISO 4217
     billing_cycle: "weekly" | "monthly" | "quarterly" | "yearly" | "other" | null,
     charge_date: string | null,       // ISO date of the charge in this email
     next_charge_date: string | null,  // ISO date if stated
     trial_end_date: string | null,    // ISO date if stated
     cancel_url: string | null,
     confidence: number                // 0–1
   }
   ```
3. Validate with Zod; on failure retry once with the issue paths (never the raw output), then mark `failed`. Soft fields (`currency`, `cancel_url`) become null instead of failing. `normalize()` clears fields for `not_subscription`, drops amounts without a currency, and drops dates more than ~1 year before or ~2 years after the sent date.
4. In one transaction: insert into `extractions` (payload = validated fields + `amount_minor`), set `processed_messages.status = 'extracted'`. The email body is never stored or logged.
5. Enqueue `ledger.merge` (singletonKey = extraction ID), except for `not_subscription`.

### 3.4 Merge (`ledger.merge`)
- Normalize merchant (`src/lib/ledger/normalize.ts`: lowercase, strip "Inc", ".com", map aliases like "SPOTIFY AB" → "spotify").
- Find subscription by `(user_id, merchant_key)`; create if missing. `plan_key` is always `""` for now: plans change (upgrades) and renewal notices often omit the plan the receipt named, so keying on plan split one subscription into several.
- Insert a `subscription_events` row (unique per extraction → idempotent), then **rebuild** the subscription (`recomputeSubscription`): lock the row (`FOR UPDATE`), load all its events ordered by the email's `sent_at`, and fold them (`src/lib/ledger/fold.ts`, pure). Order-independent, so out-of-order and duplicate merges are safe. Fold rules by `kind`:
  - `trial_started` / `trial_ending` → status `trial`, set `trial_end_date`, `next_charge_date = trial_end_date`. Services often bill on the evening before or early on the end date, so trial reminders are anchored one day earlier (see §3.5).
  - `receipt` → status `active`, update `last_charge_date`, amount; compute `next_charge_date` from cycle if not stated.
  - `renewal_notice` → set `next_charge_date`.
  - `price_change` → update amount, set `price_changed_at`.
  - `cancellation_confirmation` → status `canceled`, cancel pending reminders, delete calendar event.
- After folding, relative to today in the user's timezone: an `active` subscription with no future `next_charge_date` is projected from the latest charge + cycle; a trial whose end date passed with no follow-up email becomes `unknown` with `review_reason = trial_outcome_unknown`; an `active` one with no email for well over a cycle (70 days monthly, 430 yearly) becomes `unknown` with `review_reason = stale`.
- Fields in `subscriptions.user_overrides` (`merchantName, planName, amountMinor, currency, billingCycle, nextChargeDate, status, category`) are applied on top and never overwritten. The edit form stores only fields the user actually changed. A user-set `status` or `nextChargeDate` clears `needs_review`.
- Max confidence < 0.6 → `needs_review = true`, `review_reason = low_confidence` (no reminders until confirmed).
- Totals (`computeTotals`) count only `active`, confirmed, non-dismissed subscriptions, as monthly equivalents per currency.
- If `next_charge_date` changed → enqueue `calendar.upsert` and `reminders.plan` (which cancels reminders for the old date).

### 3.5 Plan reminders (`reminders.plan`)
- Offsets: paid `[14, 7, 1]` days; trial `[7, 3, 1]` days (skip offsets already in the past).
- Anchor date: paid → `next_charge_date`; trial → `trial_end_date − 1 day`, so the "1 day" reminder still lands before a charge that happens early on the end date. `charge_date` stored on the reminder is always the real expected charge date.
- `send_at` = 09:00 in the user's timezone on `anchor − offset` (computed with `TZDate`, stored as `timestamptz`).
- In one transaction: set `status = 'canceled'` on any `pending` reminder for this subscription whose `charge_date` ≠ the current `next_charge_date` (date moved, or subscription canceled/quiet/needs_review), then insert the new rows with `ON CONFLICT DO NOTHING` on unique `(subscription_id, charge_date, offset_days, channel)` → idempotency.

- Eligible = status `active`/`trial`, has a `next_charge_date`, not `needs_review`, `quiet` or `dismissed` (`isRemindable`). Pending rows that no longer match the plan are set `canceled`; inserts use `ON CONFLICT … DO UPDATE … WHERE status = 'canceled'` so a hidden-then-restored subscription gets its reminders back, while `sent`/`failed` rows are never touched.
- If every regular offset is already past (found too late) and nothing was planned for this charge yet, one reminder is sent immediately.
- Triggered after every `ledger.merge`, every user action on a subscription (edit, confirm, hide, quiet, add), and by the daily `subscriptions.refresh` (06:00 UTC), which recomputes every live subscription so projected dates roll forward.

### 3.6 Send (`reminders.dispatch`, cron every 15 min)
Because `send_at` is per-user local time, dispatch polls often instead of once a day.
- One transaction per reminder: claim the oldest due `pending` row with `FOR UPDATE SKIP LOCKED`, re-check the subscription is still remindable with the same charge date (else `canceled`), send, mark `sent`.
- Resend gets `idempotencyKey = reminder-<id>`, so a crash between sending and marking can't produce a second email.
- 4xx from Resend (e.g. unverified recipient on the free tier) → `failed`; other errors back off 15/30/60/120 min, `failed` after 5 attempts.
- Email (`src/lib/reminders/email-template.ts`): inline-styled HTML + text; every dynamic value is HTML-escaped (merchant names come from the LLM). Links use `APP_URL` (default: first `PUBLIC_HOSTS` entry). Keep/Cancel/Not sure action links arrive in M5.

### 3.7 Calendar (`calendar.upsert`)
- One all-day event per upcoming charge on the primary calendar: `💳 Spotify renews · $11.99` / `⏳ Hulu trial ends · then $9.99/mo`, marked transparent (free), description with cancel + SubSentry links, `extendedProperties.private.subsentrySubscriptionId`.
- Popup alerts at 09:00 on the same reminder days (minutes before 00:00 of the event: `d*1440 − 540`, trials shifted one day).
- Store `google_event_id` + `google_event_date`; update in place; delete when no longer remindable. If the user deleted the event, it stays deleted until the charge date moves.
- Missing calendar scope → skipped (email reminders still work).

### 3.8 Priority (`src/lib/priority/`)
Computed inline (it's cheap) for all of a user's subscriptions, since scores are relative: after every merge, every edit/answer in the app or from an email link, and in the daily refresh. Only live (active/trial, not hidden) subscriptions get a score; unconfirmed trials count as "Not sure". Cost percentile is among the user's subscriptions in the same currency. The usage component (activity emails) is optional in the SPEC and not collected yet.
```
score = 50
  + review:  keep +35 | cancel −40 | not_sure 0
  + cost:    −10 × (percentile of monthly-equivalent cost among user's subs − 0.5)
  + overlap: −10 if ≥ 3 active subs share a category
  + usage:   +10 if activity email seen in last 30 days, −10 if none in 60+ days (only when sender usually sends activity emails)
  clamp 0..100
```
Each component is stored in `priority_factors` (JSONB) so the UI can explain the score (`explainPriority`: "You said you plan to cancel", "One of 3 video subscriptions", "Among your most expensive"). Levels: high ≥ 65, medium ≥ 40, low < 40; Home lists the lowest as "Worth a second look".

### 3.9 Review answers (Keep / Cancel / Not sure)
- Reminder emails carry three links to `/review/<token>?a=keep|cancel|not_sure`. The token (`src/lib/crypto.ts`) is HMAC-SHA256 (`ACTION_TOKEN_SECRET`) over `{user, subscription, expiry}`, valid 14 days, checked with `timingSafeEqual`; it authorizes answering for that one subscription only, without a login.
- GET never changes anything — mail security scanners open every link — the page pre-selects the answer and the user taps **Confirm** (a POST server action).
- "Cancel" doesn't mark the subscription canceled (the user hasn't canceled yet); reminders continue until a cancellation email or the user says so, and the page offers the service's cancel link.
- The same choice is on each subscription's page.

## 4. Data model (Drizzle)

```
-- Better Auth tables (shape dictated by Better Auth; tokens encrypted by it)
users                (id, email, email_verified, name, image, timezone, created_at, updated_at)
sessions             (id, user_id, token, expires_at, ip_address, user_agent, …)
accounts             (id, user_id, provider_id, account_id, access_token, refresh_token, id_token,
                      access_token_expires_at, refresh_token_expires_at, scope, …)
verifications        (id, identifier, value, expires_at, …)

-- App tables
gmail_sync_state     (user_id PK, history_id, backfill_status, candidate_count, last_synced_at,
                      last_error, extract_paused_until, disconnected_at)
processed_messages   (user_id, gmail_message_id, status, processed_at)  PK(user_id, gmail_message_id)
extractions          (id, user_id, gmail_message_id, sender_domain, sent_at, kind, payload JSONB,
                      confidence, model, created_at)
subscriptions        (id, user_id, merchant_key, merchant_name, plan_key, plan_name,
                      category, status, amount_minor, currency, billing_cycle,
                      last_charge_date, next_charge_date, trial_end_date, cancel_url,
                      needs_review, review_reason, user_overrides JSONB, review_answer,
                      priority_score, priority_factors JSONB, google_event_id,
                      quiet, dismissed, created_at, updated_at)
                      UNIQUE(user_id, merchant_key, plan_key)
subscription_events  (id, subscription_id, extraction_id, kind, data JSONB, created_at)
reminders            (id, subscription_id, charge_date, offset_days, channel,
                      send_at, status, attempts, sent_at, error)
                      UNIQUE(subscription_id, charge_date, offset_days, channel)
```

Amounts stored as integer minor units (`amount_minor bigint`) next to an ISO 4217 `currency` — `numeric(12,2)` would be wrong for JPY (0 decimals) and KWD (3). Calendar dates as `date` in the user's timezone; instants (`send_at`, `sent_at`) as `timestamptz`.

## 5. Directory layout

```
/
├─ CLAUDE.md  SPEC.md  ARCHITECTURE.md
├─ docker-compose.yml        # postgres
├─ drizzle.config.ts
├─ src/
│  ├─ app/                   # Next.js routes
│  │  ├─ page.tsx            # landing + sign-in
│  │  ├─ (app)/              # signed-in shell (nav.tsx: top nav / bottom tabs)
│  │  │  ├─ dashboard/       # spend, coming up, review banner, scan progress
│  │  │  ├─ subscriptions/   # list, [id] detail + edit + confirm/hide, new
│  │  │  └─ settings/
│  │  ├─ api/auth/[...all]/route.ts
│  │  ├─ api/actions/review/route.ts
│  │  └─ api/subscriptions/route.ts
│  ├─ env.ts                 # Zod-validated process.env
│  ├─ proxy.ts               # optimistic session-cookie redirect for /dashboard
│  ├─ db/ schema.ts  client.ts  migrations/
│  ├─ lib/
│  │  ├─ auth/ core.ts  index.ts  client.ts  # Better Auth: shared core (worker), Next.js instance + DAL, browser client
│  │  ├─ money.ts            # major ↔ minor unit conversion per currency
│  │  ├─ crypto.ts           # HMAC action tokens
│  │  ├─ google/ auth.ts  gmail.ts  calendar.ts  known-senders.ts  backfill-query.ts
│  │  ├─ jobs/ queues.ts  boss.ts   # queue names/policies/payloads; send-only client for the app
│  │  ├─ extract/ prompt.ts  schema.ts  extract.ts  html-to-text.ts
│  │  ├─ ledger/ normalize.ts  fold.ts  merge.ts  dates.ts  categories.ts
│  │  ├─ subscriptions/ queries.ts   # read model for the UI (views, totals)
│  │  ├─ llm/ types.ts  gemini.ts  index.ts
│  │  ├─ reminders/ plan.ts  dispatch.ts  email-template.tsx
│  │  └─ priority/ score.ts
│  └─ worker/
│     ├─ index.ts            # pg-boss bootstrap, handler registration, schedules
│     └─ jobs/               # one file per job name
└─ tests/
   ├─ fixtures/emails/*.json # anonymized sample emails + expected output
   ├─ extract.eval.test.ts
   ├─ unit/…
   └─ integration/…          # against docker Postgres: npm run test:integration
```

## 6. Jobs

| Job | Trigger | Idempotency key |
|---|---|---|
| `gmail.backfill` | on connect | singleton per user |
| `gmail.sync` | `gmail.sync.all` cron every 4h → one per user | singleton per user + `processed_messages` |
| `email.extract` | per message | stately queue, singletonKey `user_id:gmail_message_id` + `processed_messages` status |
| `ledger.merge` | after extract | extraction_id |
| `calendar.upsert` | next_charge_date change | subscription_id |
| `reminders.plan` | next_charge_date change | unique constraint |
| `reminders.dispatch` | cron every 15 min | row lock + status + Resend idempotency key |
| `subscriptions.refresh` | cron daily 06:00 UTC | recompute is idempotent |
| `priority.recompute` | (queue reserved; computed inline today) | per user |

All jobs retry with exponential backoff (max 5). Google 401s trigger token refresh; `invalid_grant` marks the account disconnected and emails the user.

## 7. Configuration (`.env`)

```
DATABASE_URL=
BETTER_AUTH_SECRET=       # also the OAuth-token encryption key; openssl rand -base64 32
BETTER_AUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
ACTION_TOKEN_SECRET=
LLM_PROVIDER=gemini
GEMINI_API_KEY=           # free: https://aistudio.google.com/apikey (dev only, see §1)
EXTRACT_MODEL=gemini-flash-latest
LLM_MIN_INTERVAL_MS=6000  # pause between LLM calls; free tier ≈ 10 requests/min
RESEND_API_KEY=
EMAIL_FROM=
APP_URL=                  # optional; links in emails/calendar (default: first PUBLIC_HOSTS, else BETTER_AUTH_URL)
```

## 8. Security
- Read-only Gmail scope; Calendar `calendar.events` only.
- Tokens encrypted at rest by Better Auth (rotate by moving to versioned secrets); never logged. Email bodies never persisted or logged.
- Action links are HMAC-signed, single-purpose, expire in 14 days.
- Delete account (`src/lib/account/delete.ts`, Settings → type DELETE): remove our calendar events → revoke the Google grant (`oauth2.googleapis.com/revoke`; revoking the access token revokes its refresh token) → hard-delete the `users` row; every other table cascades from it. Google steps are best-effort: data is always deleted, and the goodbye page links to myaccount.google.com/permissions if revocation or event cleanup failed. In-flight jobs for a deleted user find no rows and exit.
- Google Cloud project stays in OAuth **testing** mode (≤ 100 test users) until Google verification and the restricted-scope security assessment are done.

## 9. Testing
- **Unit:** normalize, date math (month-end, leap years, timezones), priority score, reminder planning.
- **Extraction eval:** 51 synthetic fixture emails in `tests/fixtures/emails/` (all seven kinds plus look-alikes: one-off purchases, trial *offers*, bank alerts) → compare `kind`, `merchant`, `amount`, `currency`, `next_charge_date`/`trial_end_date`. Fails below 85% fully-correct (`EVAL_MIN_ACCURACY`, 90% from M6) or 90% detection precision. Runs against the live API only when `RUN_EVALS=1`; `EVAL_ONLY=<id>` runs a subset.
- **Integration:** against a separate `<dev db>_test` database (created + migrated by `tests/integration/global-setup.ts`), never the dev data. Gmail/Calendar/Resend/LLM are fakes behind the interfaces in `src/lib/google`, `src/lib/reminders`, `src/lib/llm`.

## 10. v2 hooks
- `transactions` table + Plaid recurring endpoint; match on merchant_key ± amount ± date window.
- `channel = 'sms'` already allowed in `reminders`; add a Twilio sender.
- Mail provider interface so Outlook (Microsoft Graph) can slot in beside Gmail.
