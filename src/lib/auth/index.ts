import "server-only";
import { nextCookies } from "better-auth/next-js";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAuth } from "./core";

// nextCookies must be the last plugin.
export const auth = createAuth([nextCookies()]);

export type SessionUser = typeof auth.$Infer.Session.user;

/** Data-access-layer entry point: the signed-in user, or a redirect to "/". */
export async function requireUser(): Promise<SessionUser> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/");
  return session.user;
}

export async function getOptionalUser(): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user ?? null;
}
