import { config } from "../config";
import { db } from "../db";
import { calendarAuth } from "../plans/index";
import { createCalendarClient } from "../plans/calendar";
import { allowedEntities, loadEntities } from "./entities";
import { voiceHa } from "./ha";
import { buildRegistry } from "./tools";
import { readGarage } from "./tools/garage";
import { vapiNotes } from "./vapi-api";
import { watchGarage } from "./watch";
import type { ToolDeps } from "./tools/deps";

// The real tool set: the real database, Home Assistant, calendar and entity allowlist.

export const entities = loadEntities();

export const toolDeps: ToolDeps = {
  db,
  entities,
  ha: config.HA_TOKEN ? voiceHa({ baseUrl: config.HA_URL, token: config.HA_TOKEN, allowed: allowedEntities(entities) }) : null,
  calendar: () => (calendarAuth.isConnected() ? createCalendarClient(calendarAuth) : null),
  writes: () => config.VOICE_HA_WRITES,
};

// When a garage move starts, tell the live call how it ended (without interrupting).
const note = config.VAPI_API_KEY ? vapiNotes({ apiKey: config.VAPI_API_KEY }) : async () => {};
toolDeps.afterMove = watchGarage({ read: () => readGarage(toolDeps, new Date()), note });

export const realRegistry = buildRegistry(toolDeps);
