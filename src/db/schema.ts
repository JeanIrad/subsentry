import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// ---------------------------------------------------------------------------
// Better Auth tables. Property names must match Better Auth's field names;
// column names are ours. Tokens in `accounts` are encrypted by Better Auth.
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  timezone: text("timezone").notNull().default("UTC"),
  ...timestamps,
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    ...timestamps,
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    accountId: text("account_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (t) => [index("accounts_user_id_idx").on(t.userId)],
);

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ...timestamps,
});

// ---------------------------------------------------------------------------
// App tables (ARCHITECTURE §4)
// ---------------------------------------------------------------------------

export const backfillStatus = pgEnum("backfill_status", ["pending", "running", "done", "failed"]);

export const gmailSyncState = pgTable("gmail_sync_state", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  historyId: text("history_id"),
  backfillStatus: backfillStatus("backfill_status").notNull().default("pending"),
  candidateCount: integer("candidate_count"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  // Short, user-facing reason for the last failure. Never contains email content.
  lastError: text("last_error"),
  // Set while email reading waits out an LLM quota (e.g. the free tier's daily cap).
  extractPausedUntil: timestamp("extract_paused_until", { withTimezone: true }),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
  ...timestamps,
});

export const processedMessageStatus = pgEnum("processed_message_status", [
  "queued",
  "extracted",
  "skipped",
  "failed",
]);

export const processedMessages = pgTable(
  "processed_messages",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    gmailMessageId: text("gmail_message_id").notNull(),
    status: processedMessageStatus("status").notNull().default("queued"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.gmailMessageId] })],
);

export const emailKind = pgEnum("email_kind", [
  "receipt",
  "renewal_notice",
  "trial_started",
  "trial_ending",
  "cancellation_confirmation",
  "price_change",
  "not_subscription",
]);

export const extractions = pgTable(
  "extractions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    gmailMessageId: text("gmail_message_id").notNull(),
    senderDomain: text("sender_domain"),
    // When the email was sent; orders events when rebuilding a subscription.
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    kind: emailKind("kind").notNull(),
    // Validated extraction output only — never the email body.
    payload: jsonb("payload").notNull(),
    confidence: real("confidence").notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("extractions_user_message_uq").on(t.userId, t.gmailMessageId)],
);

export const subscriptionStatus = pgEnum("subscription_status", [
  "trial",
  "active",
  "canceled",
  "unknown",
]);

export const billingCycle = pgEnum("billing_cycle", [
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
  "other",
]);

export const reviewAnswer = pgEnum("review_answer", ["keep", "cancel", "not_sure"]);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    merchantKey: text("merchant_key").notNull(),
    merchantName: text("merchant_name").notNull(),
    // "" rather than NULL so the unique constraint treats "no plan" as one value.
    planKey: text("plan_key").notNull().default(""),
    planName: text("plan_name"),
    category: text("category"),
    status: subscriptionStatus("status").notNull().default("unknown"),
    amountMinor: bigint("amount_minor", { mode: "number" }),
    currency: text("currency"),
    billingCycle: billingCycle("billing_cycle"),
    lastChargeDate: date("last_charge_date"),
    nextChargeDate: date("next_charge_date"),
    trialEndDate: date("trial_end_date"),
    priceChangedAt: timestamp("price_changed_at", { withTimezone: true }),
    cancelUrl: text("cancel_url"),
    needsReview: boolean("needs_review").notNull().default(false),
    reviewReason: text("review_reason").$type<"low_confidence" | "trial_outcome_unknown" | "stale">(),
    userOverrides: jsonb("user_overrides").$type<Record<string, unknown>>().notNull().default({}),
    reviewAnswer: reviewAnswer("review_answer"),
    priorityScore: integer("priority_score"),
    priorityFactors: jsonb("priority_factors").$type<Record<string, number>>(),
    googleEventId: text("google_event_id"),
    quiet: boolean("quiet").notNull().default(false),
    dismissed: boolean("dismissed").notNull().default(false),
    ...timestamps,
  },
  (t) => [unique("subscriptions_user_merchant_plan_uq").on(t.userId, t.merchantKey, t.planKey)],
);

export const subscriptionEvents = pgTable(
  "subscription_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    extractionId: uuid("extraction_id").references(() => extractions.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    data: jsonb("data"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // One event per extraction makes ledger.merge idempotent.
  (t) => [unique("subscription_events_extraction_uq").on(t.extractionId)],
);

export const reminderChannel = pgEnum("reminder_channel", ["email", "sms"]);
export const reminderStatus = pgEnum("reminder_status", ["pending", "sent", "failed", "canceled"]);

export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    chargeDate: date("charge_date").notNull(),
    offsetDays: integer("offset_days").notNull(),
    channel: reminderChannel("channel").notNull().default("email"),
    sendAt: timestamp("send_at", { withTimezone: true }).notNull(),
    status: reminderStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [
    unique("reminders_idempotency_uq").on(t.subscriptionId, t.chargeDate, t.offsetDays, t.channel),
    index("reminders_due_idx").on(t.sendAt).where(sql`${t.status} = 'pending'`),
  ],
);
