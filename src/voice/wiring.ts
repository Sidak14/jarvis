import { config } from "../config";
import { settings } from "../settings";
import { db } from "../db";
import { calendarAuth } from "../plans/index";
import { createCalendarClient } from "../plans/calendar";
import { allowedEntities, loadEntities, parseLightLines, type Entities } from "./entities";
import { voiceHa } from "./ha";
import { buildRegistry } from "./tools";
import { readGarage } from "./tools/garage";
import { vapiNotes } from "./vapi-api";
import { watchGarage } from "./watch";
import type { ToolDeps } from "./tools/deps";

// The real tool set: the real database, Home Assistant, calendar and entity allowlist.

const base = loadEntities();
/** The voice allowlist as it is now: the garage from voice/entities.yaml, the lights from the dashboard setting when I have edited it. */
export function liveEntities(): Entities {
  const edited = settings.raw("home.voice_lights");
  if (edited === null) return base;
  try {
    return { garage: base.garage, lights: parseLightLines(edited) };
  } catch {
    return base; // a bad saved list never takes voice down
  }
}
export const entities = base;

export const toolDeps: ToolDeps = {
  db,
  get entities() {
    return liveEntities();
  },
  ha: config.HA_TOKEN ? voiceHa({ baseUrl: config.HA_URL, token: config.HA_TOKEN, allowed: () => allowedEntities(liveEntities()) }) : null,
  calendar: () => (calendarAuth.isConnected() ? createCalendarClient(calendarAuth) : null),
  writes: () => settings.str("voice.ha_writes") as "dry" | "live",
};

// When a garage move starts, tell the live call how it ended (without interrupting).
const note = config.VAPI_API_KEY ? vapiNotes({ apiKey: config.VAPI_API_KEY }) : async () => {};
toolDeps.afterMove = watchGarage({ read: () => readGarage(toolDeps, new Date()), note });

export const realRegistry = buildRegistry(toolDeps);
