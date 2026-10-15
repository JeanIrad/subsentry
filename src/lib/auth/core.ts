import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/db/client";
import * as schema from "@/db/schema";
import { env } from "@/env";
import { enqueueBackfill } from "@/lib/jobs/boss";

// Better Auth already requests openid/email/profile.
export const GOOGLE_SCOPES = [
  // Hard rule: read-only. Never add send/modify scopes (CLAUDE.md).
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

/**
 * Builds the Better Auth instance. The Next.js app adds the `nextCookies`
 * plugin (see ./index.ts); the worker uses the core instance without it.
 */
export function createAuth<P extends BetterAuthPlugin[]>(plugins: P) {
  const localHost = new URL(env.BETTER_AUTH_URL).host;
  return betterAuth({
    // With PUBLIC_HOSTS set, the auth URLs (incl. Google's redirect URI) follow
    // whichever allowed host the request came in on: localhost or the tunnel.
    baseURL:
      env.PUBLIC_HOSTS.length === 0
        ? env.BETTER_AUTH_URL
        : { allowedHosts: [localHost, ...env.PUBLIC_HOSTS], fallback: env.BETTER_AUTH_URL, protocol: "auto" },
    trustedOrigins: env.PUBLIC_HOSTS.map((h) => `https://${h}`),
    // Tunnels (ngrok) set x-forwarded-host/proto; only trusted when we opted in.
    advanced: { trustedProxyHeaders: env.PUBLIC_HOSTS.length > 0 },
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "pg", schema, usePlural: true }),
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        scope: GOOGLE_SCOPES,
        // offline + consent so Google always returns a refresh token.
        accessType: "offline",
        prompt: "consent",
      },
    },
    account: {
      encryptOAuthTokens: true,
    },
    user: {
      additionalFields: {
        timezone: { type: "string", required: false, defaultValue: "UTC", input: false },
      },
    },
    databaseHooks: {
      // On account (not user) creation: the user row is written before the
      // Google tokens are, so a job enqueued from the user hook could race them.
      account: {
        create: {
          after: async (account) => {
            if (account.providerId !== "google") return;
            await db
              .insert(schema.gmailSyncState)
              .values({ userId: account.userId })
              .onConflictDoNothing();
            await enqueueBackfill(account.userId);
          },
        },
      },
    },
    plugins,
  });
}

export const coreAuth = createAuth([]);
