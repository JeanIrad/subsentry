import { z } from "zod";

// Validated once at import. Only server code may import this module.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url(),
  // Direct (non-pooled) connection, set by Neon's Vercel integration. pg-boss
  // and migrations need session features a transaction pooler doesn't keep.
  DATABASE_URL_UNPOOLED: z.url().optional(),
  BETTER_AUTH_SECRET: z.string().min(32, "use `openssl rand -base64 32`"),
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
  // Extra hostnames the app is reached at, e.g. an ngrok tunnel for phone testing.
  // Comma-separated, no scheme: "jean-subsentry.ngrok-free.app"
  PUBLIC_HOSTS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((h) => h.trim()).filter(Boolean)),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  // Signs Keep / Cancel / Not sure links in reminder emails: openssl rand -base64 32
  ACTION_TOKEN_SECRET: z.string().min(32, "use `openssl rand -base64 32`"),
  LLM_PROVIDER: z.enum(["gemini"]).default("gemini"),
  GEMINI_API_KEY: z.string().optional(),
  EXTRACT_MODEL: z.string().default("gemini-flash-lite-latest"),
  // Pause between LLM calls in the worker. Free tiers allow only a few requests/minute.
  LLM_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(6000),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("SubSentry <onboarding@resend.dev>"),
  // Base URL for links in emails/calendar events. Defaults to the first
  // PUBLIC_HOSTS entry (reachable from a phone), else BETTER_AUTH_URL.
  APP_URL: z.url().optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables (see .env.example):\n${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv();

export const appUrl = (
  env.APP_URL ?? (env.PUBLIC_HOSTS[0] ? `https://${env.PUBLIC_HOSTS[0]}` : env.BETTER_AUTH_URL)
).replace(/\/$/, "");

/** Connection for pg-boss (job queue): direct, never through a pooler. */
export const directDatabaseUrl = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;
