import { auth, calendar, type calendar_v3 } from "@googleapis/calendar";
import { googleErrorStatus } from "./gmail";

export interface CalendarEventInput {
  subscriptionId: string;
  title: string;
  description: string;
  /** All-day event on this date (YYYY-MM-DD). */
  date: string;
  /** Popup alerts, in minutes before 00:00 of `date`. Max 5, ≤ 40320 each. */
  alertMinutes: number[];
}

/** Mocked in tests. */
export interface CalendarClient {
  create(e: CalendarEventInput): Promise<string>;
  /** false if the event no longer exists (the user deleted it). */
  update(eventId: string, e: CalendarEventInput): Promise<boolean>;
  remove(eventId: string): Promise<void>;
}

const CALENDAR_ID = "primary";

export function createCalendarClient(accessToken: string): CalendarClient {
  const oauth = new auth.OAuth2();
  oauth.setCredentials({ access_token: accessToken });
  const client = calendar({ version: "v3", auth: oauth });

  const body = (e: CalendarEventInput): calendar_v3.Schema$Event => {
    const end = new Date(`${e.date}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    return {
      summary: e.title,
      description: e.description,
      start: { date: e.date },
      end: { date: end.toISOString().slice(0, 10) },
      transparency: "transparent", // doesn't block the day as busy
      reminders: {
        useDefault: false,
        overrides: e.alertMinutes.slice(0, 5).map((minutes) => ({ method: "popup", minutes: Math.min(minutes, 40320) })),
      },
      extendedProperties: { private: { subsentrySubscriptionId: e.subscriptionId } },
    };
  };
  const gone = (err: unknown) => [404, 410].includes(googleErrorStatus(err) ?? 0);

  return {
    async create(e) {
      const { data } = await client.events.insert({ calendarId: CALENDAR_ID, requestBody: body(e) });
      if (!data.id) throw new Error("Calendar returned no event id");
      return data.id;
    },
    async update(eventId, e) {
      try {
        const { data } = await client.events.get({ calendarId: CALENDAR_ID, eventId });
        if (data.status === "cancelled") return false;
        await client.events.update({ calendarId: CALENDAR_ID, eventId, requestBody: body(e) });
        return true;
      } catch (err) {
        if (gone(err)) return false;
        throw err;
      }
    },
    async remove(eventId) {
      try {
        await client.events.delete({ calendarId: CALENDAR_ID, eventId });
      } catch (err) {
        if (!gone(err)) throw err;
      }
    },
  };
}
