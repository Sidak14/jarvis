import { config } from "../config";
import { db } from "../db";
import { calendarAuth } from "../plans/index";
import { createCalendarClient } from "../plans/calendar";
import { allowedEntities, loadEntities } from "./entities";
import { voiceHa } from "./ha";
import { buildRegistry } from "./tools";

// The real tool set: the real database, Home Assistant, calendar and entity allowlist.

export const entities = loadEntities();

export const realRegistry = buildRegistry({
  db,
  entities,
  ha: config.HA_TOKEN ? voiceHa({ baseUrl: config.HA_URL, token: config.HA_TOKEN, allowed: allowedEntities(entities) }) : null,
  calendar: () => (calendarAuth.isConnected() ? createCalendarClient(calendarAuth) : null),
  writes: () => config.VOICE_HA_WRITES,
});
