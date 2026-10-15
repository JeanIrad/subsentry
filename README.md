# SubSentry

Finds subscriptions and free trials in your Gmail and reminds you (email + Google Calendar) before you're charged. See `SPEC.md` and `ARCHITECTURE.md`.

## Status

MVP milestones M0–M6 (SPEC §11) are implemented: Google sign-in, Gmail backfill + 4-hourly sync, LLM extraction
(eval ≥ 90%), subscription ledger with review prompts, email + Google Calendar reminders, Keep/Cancel/Not sure with a
priority score, and account deletion. Before onboarding anyone beyond test users: switch to a paid LLM key, verify a
sending domain in Resend, and complete Google's restricted-scope verification (SPEC §9).

## Local setup

Requires Node 24+ and Docker.

1. `npm install`
2. `cp .env.example .env`, then set `BETTER_AUTH_SECRET` (`openssl rand -base64 32`).
3. Google Cloud console:
   - Enable the **Gmail API** and **Google Calendar API**.
   - OAuth consent screen: External, **Testing** mode; add yourself as a test user; add scopes `gmail.readonly` and `calendar.events`.
   - Credentials → OAuth client ID (Web application), redirect URI `http://localhost:3000/api/auth/callback/google`.
   - Put the client ID/secret in `.env`.
4. `docker compose up -d` and `npm run db:migrate`
5. `npm run dev:all` — starts the web app **and** the background worker. (Or `npm run dev` and `npm run worker` in two terminals.) Without the worker, scans stay "queued" forever.

## Use it on your phone

The app installs to your home screen (PWA), which needs HTTPS, so expose the dev server through a tunnel:

1. Get a free static domain from [ngrok](https://ngrok.com) (Dashboard → Domains), install the agent, then run
   `ngrok http --url=<your-domain> 3000` next to `npm run dev` and `npm run worker`.
2. In `.env`, set `PUBLIC_HOSTS=<your-domain>` and restart `npm run dev` and `npm run worker`.
3. In the Google OAuth client, add origin `https://<your-domain>` and redirect URI
   `https://<your-domain>/api/auth/callback/google`.
4. Open `https://<your-domain>` on the phone → iPhone: Share → Add to Home Screen · Android: ⋮ → Install app.

## Checks

`npm run typecheck` · `npm run lint` · `npm test`
