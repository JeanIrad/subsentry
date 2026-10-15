# SubSentry — Product Spec (MVP)

> Working name. An agent that finds your subscriptions and free trials in your inbox and warns you before you're charged.

## 1. Problem

People sign up for free trials and subscriptions across dozens of services and lose track of them. Trials silently convert to paid plans, annual renewals arrive unexpectedly, and duplicate or unused services keep billing. Existing trackers mostly require manual entry, which users abandon, and bank-based trackers only see a subscription *after* the first charge — too late for a free trial.

## 2. MVP goal

Prove one thing: **an agent can discover a user's subscriptions and free trials from their email with no manual entry, and alert them early enough to act.**

Success = a user connects Gmail and, within minutes, sees a list of subscriptions/trials they recognize (including at least one they'd forgotten), with upcoming charge dates and reminders on their calendar.

## 3. Users

- **Primary:** individuals with 5+ subscriptions who sign up for trials and forget them.
- **MVP audience:** the developer plus up to ~100 test users (Gmail OAuth "testing" mode limit — see §9).

## 4. Scope

### In scope (MVP)
1. **Account + Gmail connection** — Google sign-in with read-only Gmail access.
2. **Backfill scan** — scan the last 12 months of email for receipts, renewal notices, and trial confirmations.
3. **Incremental sync** — check for new relevant email every few hours.
4. **AI extraction** — for each candidate email, extract: service name, plan, price, currency, billing cycle, trial status, trial end date, next charge date, cancellation link (if present).
5. **Subscription ledger** — merge extractions into one record per subscription; track status (`trial`, `active`, `canceled`, `unknown`).
6. **Charge date prediction** — compute the next expected charge from explicit dates or from cycle + last charge.
7. **Reminders**
   - Paid renewals: **14 days, 7 days, 1 day** before charge.
   - Free trials: **7 days (if possible), 3 days, 1 day** before conversion.
   - Delivered by **email** and as a **Google Calendar event** (with calendar-native alerts).
8. **Priority + review** — each subscription gets a priority score; every reminder email includes one-click **Keep / Cancel / Not sure** buttons. Answers feed the score.
9. **Dashboard** — mobile-first, installable as an app (PWA: home-screen icon, full-screen, no app store); list of subscriptions with cost, next charge, status, priority; monthly and yearly totals; manual edit/add/dismiss.
10. **Cancellation help** — link to the service's cancellation page (from the email or a curated lookup table).

### Out of scope (later versions)
- Bank/card connection (Plaid) and transaction matching — **v2**
- SMS notifications (Twilio, requires A2P 10DLC registration) — **v2**
- Outlook/Microsoft 365 email — v2
- Automated cancellation on the user's behalf
- Native App Store / Play Store apps (v2: wrap or port the PWA once the core is proven), browser extension, family/shared accounts
- Bill negotiation

## 5. User stories

| # | As a user, I want to… | So that… |
|---|---|---|
| U1 | connect Gmail in one click | I don't have to enter subscriptions manually |
| U2 | see all my subscriptions and trials in one list | I know what I'm paying for |
| U3 | get a calendar event and email before a trial converts | I can cancel in time |
| U4 | get reminders 14/7/1 days before renewals | big annual charges don't surprise me |
| U5 | mark each subscription Keep / Cancel / Not sure from the reminder | I can decide without opening the app |
| U6 | see monthly and yearly totals | I understand my total spend |
| U7 | correct or dismiss a wrongly detected item | the list stays accurate |
| U8 | disconnect and delete all my data | I stay in control of my inbox access |

## 6. Functional requirements

### 6.1 Detection
- FR-1: Backfill must use Gmail search pre-filtering (keywords + known sender domains) before any LLM call, to control cost.
- FR-2: Each candidate email is classified as `receipt`, `renewal_notice`, `trial_started`, `trial_ending`, `cancellation_confirmation`, `price_change`, or `not_subscription`.
- FR-3: Extraction returns structured JSON validated against a schema; invalid output is retried once, then logged and skipped.
- FR-4: Each extraction stores a confidence score and a link back to the source email ID (never the full body long-term — see §8).
- FR-5: Items below a confidence threshold appear in a "Needs review" section rather than generating reminders.

### 6.2 Ledger
- FR-6: Extractions are merged into subscriptions by normalized merchant name + plan.
- FR-7: A `cancellation_confirmation` sets status to `canceled` and cancels pending reminders.
- FR-8: A `price_change` updates price and is flagged in the next reminder.
- FR-9: The user can edit any field; user edits override future extractions for that field.

### 6.3 Reminders
- FR-10: A daily job creates due reminders; each reminder is sent at most once (idempotent).
- FR-11: One calendar event per upcoming charge, created at detection time and updated if the date changes.
- FR-12: Reminder email includes: service, amount, charge date, days left, priority, cancellation link, Keep/Cancel/Not sure buttons.
- FR-13: Users can set quiet mode per subscription (e.g. "never remind me about rent-like essentials").

### 6.4 Priority score (0–100)
Inputs, MVP version:
- User answer (Keep = high, Cancel = low, Not sure = neutral) — strongest weight
- Cost relative to the user's other subscriptions
- Category overlap (e.g. 3+ streaming services)
- Recent usage signals in email (watch history, "you listened to…", login/activity emails) — optional, best-effort
- Trial status (unconfirmed trials start at "Not sure")

The score is explainable: the UI shows *why* (e.g. "3rd streaming service · no activity emails in 60 days").

## 7. Non-functional requirements
- **Security:** OAuth tokens encrypted at rest; read-only Gmail scope; least-privilege Calendar scope.
- **Privacy:** store extracted fields only; raw email bodies are processed in memory and not persisted (except an opt-in debug mode in dev).
- **Cost:** target < $0.05 per user for backfill LLM usage via pre-filtering and a small model. Development runs on the free Gemini tier (rate-limited; own inboxes only).
- **Reliability:** reminders must never be sent twice or skipped; jobs are idempotent and retryable.
- **Accuracy target:** ≥ 90% precision on detected subscriptions in the test set (§10).

## 8. Data handling
- Persist: subscription fields, Gmail message ID, sender domain, extraction confidence, timestamps.
- Do not persist: email bodies, attachments, unrelated email metadata.
- Delete-account flow revokes Google tokens and hard-deletes all user rows.

## 9. Constraints and risks
| Risk | Mitigation |
|---|---|
| `gmail.readonly` is a Google *restricted* scope: public launch needs Google verification + a third-party security assessment | Stay in OAuth testing mode (≤100 users) for MVP; plan verification before public launch |
| LLM misreads dates/prices | Schema validation, confidence threshold, "Needs review" queue, user edits win |
| Trials without a confirmation email | Accept as a known gap in MVP; v2 adds card transaction matching |
| Calendar spam | One event per charge, not per reminder; calendar-native alerts handle the 14/7/1 cadence |
| Users distrust inbox access | Clear permission explainer, data-handling page, one-click disconnect + delete |

## 10. Evaluation
- Build a labeled fixture set of ~50 anonymized emails (receipts, trial starts, cancellations, newsletters/noise).
- Track precision/recall of classification and exact-match accuracy of price + next-charge date.
- Run the eval in CI on prompt or model changes.

## 11. Milestones
| # | Milestone | Done when |
|---|---|---|
| M0 | Scaffold | App runs locally; DB migrations; Google sign-in works |
| M1 | Gmail backfill | Candidate emails fetched with pre-filter query; counts shown |
| M2 | Extraction | Emails → validated JSON; eval set passes ≥ 85% |
| M3 | Ledger + dashboard | Subscriptions merged and listed with totals; manual edit |
| M4 | Reminders | Daily job sends emails + creates calendar events; idempotent |
| M5 | Priority + review buttons | Keep/Cancel/Not sure updates score; explanations shown |
| M6 | Hardening | Incremental sync, delete-account, token encryption, eval ≥ 90% |

## 12. v2 preview
Plaid recurring-transactions matching, SMS via Twilio, Outlook support, price-hike detection from transactions, cost-per-use insights.
