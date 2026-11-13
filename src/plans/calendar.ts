import { TIMEZONE } from "./settings";

// Google Calendar, over plain fetch (like Sheets and Gmail). Everything Jarvis creates carries a
// PRIVATE extended property jarvis_plan_id, and Jarvis only ever changes or deletes events that
// have it. That is also how a restart finds an event it already made (so it never makes two).

const API = "https://www.googleapis.com/calendar/v3";

export interface CalendarEventInput {
  planId: string; // P-0001
  title: string;
  description: string;
  location: string | null;
  startIso: string; // exact instants
  endIso: string;
}
export interface BusyEvent {
  summary: string;
  startIso: string;
  endIso: string;
  calendar: string;
}
export interface CalendarClient {
  /** Events (on any calendar) overlapping the time range, ignoring all-day, declined and "free" ones. */
  overlapping(startIso: string, endIso: string, ignorePlanId?: string): Promise<BusyEvent[]>;
  /** The event Jarvis made for this plan, if it exists. */
  findByPlan(planId: string): Promise<{ id: string; link: string } | null>;
  create(input: CalendarEventInput): Promise<{ id: string; link: string }>;
  update(eventId: string, input: CalendarEventInput): Promise<{ id: string; link: string }>;
  /** Deletes the event, but only if it was created by Jarvis for this plan. Returns false if it was not (or is gone). */
  removeIfOurs(eventId: string, planId: string): Promise<boolean>;
}

export class CalendarError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  htmlLink?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string> };
}

export function createCalendarClient(auth: { getAccessToken(force?: boolean): Promise<string> }, fetchFn: typeof fetch = fetch): CalendarClient {
  async function call<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T | null> {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await auth.getAccessToken(attempt > 0);
      const res = await fetchFn(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 401 && attempt === 0) continue; // token went stale: refresh once
      if (res.status === 404 || res.status === 410) return null;
      if (!res.ok) throw new CalendarError(`Google Calendar HTTP ${res.status}`, res.status);
      return res.status === 204 ? (null as T) : ((await res.json()) as T);
    }
    throw new CalendarError("Google Calendar: not authorised", 401);
  }

  const toBody = (e: CalendarEventInput) => ({
    summary: e.title,
    description: e.description,
    ...(e.location ? { location: e.location } : {}),
    start: { dateTime: e.startIso, timeZone: TIMEZONE },
    end: { dateTime: e.endIso, timeZone: TIMEZONE },
    extendedProperties: { private: { jarvis_plan_id: e.planId } },
  });

  return {
    async overlapping(startIso, endIso, ignorePlanId) {
      const list = await call<{ items?: { id: string; summary?: string; accessRole?: string; selected?: boolean }[] }>("GET", "/users/me/calendarList");
      const found: BusyEvent[] = [];
      for (const cal of list?.items ?? []) {
        if (cal.selected === false || /holiday@group\.v\.calendar\.google\.com$/.test(cal.id)) continue;
        const events = await call<{ items?: GEvent[] }>("GET", `/calendars/${encodeURIComponent(cal.id)}/events`, undefined, {
          timeMin: startIso,
          timeMax: endIso,
          singleEvents: "true",
          maxResults: "50",
        });
        for (const ev of events?.items ?? []) {
          if (ev.status === "cancelled" || ev.transparency === "transparent") continue;
          if (!ev.start?.dateTime || !ev.end?.dateTime) continue; // all-day: birthdays, holidays
          if (ev.attendees?.some((a) => a.self && a.responseStatus === "declined")) continue;
          if (ignorePlanId && ev.extendedProperties?.private?.jarvis_plan_id === ignorePlanId) continue;
          found.push({ summary: ev.summary ?? "(no title)", startIso: ev.start.dateTime, endIso: ev.end.dateTime, calendar: cal.summary ?? cal.id });
        }
      }
      return found;
    },

    async findByPlan(planId) {
      const res = await call<{ items?: GEvent[] }>("GET", "/calendars/primary/events", undefined, {
        privateExtendedProperty: `jarvis_plan_id=${planId}`,
        showDeleted: "false",
        maxResults: "5",
      });
      const ev = (res?.items ?? []).find((e) => e.status !== "cancelled");
      return ev ? { id: ev.id, link: ev.htmlLink ?? "" } : null;
    },

    async create(input) {
      const ev = await call<GEvent>("POST", "/calendars/primary/events", toBody(input));
      if (!ev) throw new CalendarError("Google Calendar did not create the event");
      return { id: ev.id, link: ev.htmlLink ?? "" };
    },

    async update(eventId, input) {
      const ev = await call<GEvent>("PUT", `/calendars/primary/events/${encodeURIComponent(eventId)}`, toBody(input));
      if (!ev) throw new CalendarError("The event no longer exists", 404);
      return { id: ev.id, link: ev.htmlLink ?? "" };
    },

    async removeIfOurs(eventId, planId) {
      const ev = await call<GEvent>("GET", `/calendars/primary/events/${encodeURIComponent(eventId)}`);
      if (!ev || ev.status === "cancelled") return false;
      if (ev.extendedProperties?.private?.jarvis_plan_id !== planId) return false; // not ours: never touch it
      await call("DELETE", `/calendars/primary/events/${encodeURIComponent(eventId)}`);
      return true;
    },
  };
}
