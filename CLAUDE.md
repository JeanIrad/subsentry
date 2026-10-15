# CLAUDE.md

Project: **SubSentry** — finds subscriptions and free trials in a user's Gmail and sends reminders (email + Google Calendar) before they're charged.

Read `SPEC.md` (what and why) and `ARCHITECTURE.md` (how) before making changes. Build milestone by milestone (SPEC §11); don't jump ahead to v2 features (Plaid, SMS, Outlook).

## Commands
- `docker compose up -d` — start Postgres
- `npm run dev` — Next.js app (http://localhost:3000)
- `npm run worker` — pg-boss worker (`npm run dev:all` runs web + worker together; scans and extraction need the worker)
- `npm run db:generate` / `npm run db:migrate` — Drizzle migrations
- `npm test` — unit tests · `npm run test:integration` (docker Postgres; uses its own `*_test` database) · `npm run typecheck` · `npm run lint`
- `RUN_EVALS=1 npm run eval` — extraction eval against the live LLM (takes ~6 min on the free tier)

## Conventions
- TypeScript strict; no `any`. Validate all external input (LLM output, API bodies, Google responses) with Zod.
- Every background job must be idempotent (see ARCHITECTURE §6).
- External services (Gmail, Calendar, Claude, Resend) sit behind small interfaces in `src/lib/*` so tests can mock them.
- Dates: store as `date` in the user's timezone; use date-fns v4 + `@date-fns/tz` only.
- Money: integer minor units everywhere (`amount_minor bigint` + ISO currency). Convert LLM major-unit amounts once, at the extraction boundary, with `src/lib/money.ts` (handles 0- and 3-decimal currencies). Never do arithmetic on floats.
- Next.js is v16: check `node_modules/next/dist/docs/` before using an API you remember from older versions (e.g. `middleware.ts` is now `proxy.ts`; `headers()`/`cookies()` are async).
- UI: mobile-first. Use the design tokens in `src/app/globals.css` (`brand-*`, `ink`, `muted`, `canvas`, `surface`, `line`) and `button`/`card` from `src/components/ui.ts`, never raw Tailwind palette colors. Signed-in pages live under `src/app/(app)/` (shared shell + tabs in `nav.tsx`). Check new screens at 390px width.
- Auth is Better Auth (`src/lib/auth.ts`). Get Google access tokens through `getGoogleAccessToken()` in `src/lib/google/auth.ts`, never by reading the `accounts` table directly (tokens are encrypted there).

## Hard rules
- Never persist or log email bodies, decrypted OAuth tokens, or full API responses containing email content.
- Gmail scope stays `gmail.readonly`. Don't add send/modify scopes.
- The free Gemini tier is for the developer's own test inboxes only. Before any other user signs up, switch to a paid LLM key (see ARCHITECTURE §1).
- Never log LLM requests or responses: they contain email content.
- User-edited fields (`subscriptions.user_overrides`) are never overwritten by extraction.
- A reminder must never be sent twice: rely on the DB unique constraint, not app logic alone.

## When unsure
Prefer the simplest approach that satisfies SPEC.md. Ask before adding new infrastructure (Redis, extra services) or new OAuth scopes.
