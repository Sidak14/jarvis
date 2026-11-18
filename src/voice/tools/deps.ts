import type Database from "better-sqlite3";
import type { Entities } from "../entities";
import type { VoiceHa } from "../ha";
import type { CalendarClient } from "../../plans/calendar";

/** Everything the tools need from the rest of Jarvis, passed in so tests can fake it. */
export interface ToolDeps {
  db: Database.Database;
  entities: Entities;
  /** null when Home Assistant is not set up. */
  ha: VoiceHa | null;
  /** null when Google Calendar is not connected. */
  calendar: () => CalendarClient | null;
  /** dry: the Home Assistant tools say what they would do and change nothing. live: they do it. */
  writes: () => "dry" | "live";
  /** Called once a garage door has started moving: tells the call when it has finished (see watch.ts). */
  afterMove?: (callId: string, want: "open" | "closed") => void;
  /** Waits between Home Assistant checks (replaced in tests). */
  sleep?: (ms: number) => Promise<void>;
}

export const wait = (deps: ToolDeps, ms: number) => (deps.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);
