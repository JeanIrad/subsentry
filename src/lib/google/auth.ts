import { isAPIError } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema";
import { coreAuth } from "@/lib/auth/core";

export const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
export const CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";

/** The user must sign in with Google again; retrying won't help. */
export class GoogleReconnectRequiredError extends Error {
  constructor(public readonly reason: "not_linked" | "missing_scope" | "refresh_failed") {
    super(
      {
        not_linked: "No Google account is linked.",
        missing_scope: "Gmail read access wasn't granted. Reconnect Google and tick the Gmail box.",
        refresh_failed: "Google access expired or was revoked. Reconnect Google.",
      }[reason],
    );
    this.name = "GoogleReconnectRequiredError";
  }
}

/**
 * Returns a valid Google access token for the user, refreshing it if expired,
 * and checks that the required scopes were granted. Tokens are stored
 * encrypted, so always go through this — never read `accounts.access_token`
 * directly. Never log the return value.
 */
export async function getGoogleAccessToken(
  userId: string,
  requiredScopes: readonly string[] = [GMAIL_READONLY],
): Promise<string> {
  const [account] = await db
    .select({ id: accounts.id, scope: accounts.scope, refreshToken: accounts.refreshToken })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "google")))
    .limit(1);
  if (!account) throw new GoogleReconnectRequiredError("not_linked");

  const granted = new Set((account.scope ?? "").split(/[ ,]+/).filter(Boolean));
  if (requiredScopes.some((s) => !granted.has(s))) {
    throw new GoogleReconnectRequiredError("missing_scope");
  }

  try {
    const { accessToken } = await coreAuth.api.getAccessToken({
      body: { accountId: account.id, userId },
    });
    if (!accessToken) throw new GoogleReconnectRequiredError("refresh_failed");
    return accessToken;
  } catch (err) {
    // Better Auth collapses refresh failures (revoked grant, network error)
    // into one error. Without a refresh token it can never recover; otherwise
    // let the job retry and surface the error if it keeps failing.
    if (isAPIError(err) && !account.refreshToken) {
      throw new GoogleReconnectRequiredError("refresh_failed");
    }
    throw err;
  }
}
