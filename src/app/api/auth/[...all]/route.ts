import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

// Sign-up starts the first scan, which may run a job tick after responding.
export const maxDuration = 300;

export const { GET, POST } = toNextJsHandler(auth);
