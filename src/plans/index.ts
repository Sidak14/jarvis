import { config } from "../config";
import { db } from "../db";
import { CalendarAuth } from "./calendar-auth";

/** The one shared Google Calendar login for the whole server (same Google client as Gmail). */
export const calendarAuth = new CalendarAuth(
  db,
  config.GMAIL_CLIENT_ID ?? "",
  config.GMAIL_CLIENT_SECRET ?? "",
  config.CALENDAR_REDIRECT_URI,
);
