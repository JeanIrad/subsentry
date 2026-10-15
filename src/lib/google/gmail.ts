import { auth, gmail, type gmail_v1 } from "@googleapis/gmail";

/**
 * One email, decoded. Lives in memory only — never persist or log `html`/`text`
 * (CLAUDE.md hard rule).
 */
export interface EmailMessage {
  id: string;
  from: string;
  subject: string;
  /** Sent time (ISO 8601), from Gmail's internalDate. */
  date: string;
  text: string | null;
  html: string | null;
}

/** The slice of Gmail the app uses. Mocked in tests. */
export interface GmailReader {
  /** Current mailbox history ID; incremental sync starts from here. */
  getHistoryId(): Promise<string>;
  listMessageIds(query: string, pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }>;
  /** null if the message no longer exists (deleted since listing). */
  getMessage(id: string): Promise<EmailMessage | null>;
}

const PAGE_SIZE = 500; // Gmail's max for messages.list

export function createGmailReader(accessToken: string): GmailReader {
  const oauth = new auth.OAuth2();
  oauth.setCredentials({ access_token: accessToken });
  const client = gmail({ version: "v1", auth: oauth });

  return {
    async getHistoryId() {
      const { data } = await client.users.getProfile({ userId: "me" });
      if (!data.historyId) throw new Error("Gmail profile has no historyId");
      return data.historyId;
    },
    async listMessageIds(query, pageToken) {
      const { data } = await client.users.messages.list({
        userId: "me",
        q: query,
        maxResults: PAGE_SIZE,
        pageToken,
      });
      const ids = (data.messages ?? []).flatMap((m) => (m.id ? [m.id] : []));
      return { ids, nextPageToken: data.nextPageToken ?? undefined };
    },
    async getMessage(id) {
      try {
        const { data } = await client.users.messages.get({ userId: "me", id, format: "full" });
        return parseMessage(data);
      } catch (err) {
        if (googleErrorStatus(err) === 404) return null;
        throw err;
      }
    },
  };
}

export function parseMessage(msg: gmail_v1.Schema$Message): EmailMessage {
  const headers = msg.payload?.headers ?? [];
  const header = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

  let text: string | null = null;
  let html: string | null = null;
  const walk = (part: gmail_v1.Schema$MessagePart | undefined) => {
    if (!part) return;
    if (part.filename) return; // attachment
    const data = part.body?.data;
    if (data && part.mimeType === "text/plain" && text === null) text = decodeBase64Url(data);
    if (data && part.mimeType === "text/html" && html === null) html = decodeBase64Url(data);
    part.parts?.forEach(walk);
  };
  walk(msg.payload);

  const internal = Number(msg.internalDate);
  return {
    id: msg.id ?? "",
    from: header("From"),
    subject: header("Subject"),
    date: new Date(Number.isFinite(internal) ? internal : Date.parse(header("Date"))).toISOString(),
    text,
    html,
  };
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/** "Spotify <no-reply@spotify.com>" → "spotify.com" */
export function senderDomain(from: string): string | null {
  const match = /@([a-z0-9.-]+\.[a-z]{2,})/i.exec(from);
  return match ? match[1].toLowerCase() : null;
}

/** HTTP status of a Google API error (gaxios), if any. */
export function googleErrorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  const status = e.status ?? e.response?.status ?? e.code;
  return typeof status === "number" ? status : undefined;
}
