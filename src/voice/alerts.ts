import type Database from "better-sqlite3";
import { settings } from "../settings";
import { dayKey, zoned } from "../telegram/time";
import { budget } from "./budget";
import { registerCall, renameCall, type CallRow } from "./calls";
import { spokenDuration } from "./speak";
import type { GarageReading } from "./tools/garage";

// Jarvis phones me about something important. The rules (all in decide(), plain code):
//   - one OPEN "episode" per kind (the garage has been left open); a second report of the same thing joins it
//   - it ends the moment the thing is fixed (the garage closes): no more calls
//   - at most one call every 30 minutes, and at most 3 calls a day (Sydney) for each kind
//   - 11pm to 7am only urgent kinds may call (the garage is urgent)
//   - at the monthly voice limit it does not call; Telegram only
// If I do not answer, it is busy, it goes to voicemail, or the call fails: a Telegram message says so instead.

export interface AlertKind {
  /** May phone between 11pm and 7am. */
  urgent: boolean;
}
export const ALERT_KINDS: Record<string, AlertKind> = { garage_open: { urgent: true } };

// The defaults. The live values are settings (voice.* on the Calls page), read where they are used.
export const GARAGE_OPEN_SECONDS = 600;
export const MIN_GAP_MS = 30 * 60_000;
export const MAX_PER_DAY = 3;
export const QUIET_FROM_HOUR = 23;
export const QUIET_UNTIL_HOUR = 7;

export interface Episode {
  id: number;
  kind: string;
  started_at: string;
  last_attempt_at: string | null;
  attempts_today: number;
  attempts_day: string | null;
  resolved_at: string | null;
  detail: string | null;
}

export type Decision = { action: "call" } | { action: "telegram_only"; reason: string } | { action: "wait"; reason: string } | { action: "stop"; reason: string };

export function decide(ep: Episode, now: Date, opts: { stillActive: boolean; budgetCapped: boolean }): Decision {
  if (ep.resolved_at) return { action: "stop", reason: "resolved" };
  if (!opts.stillActive) return { action: "stop", reason: "no longer the case" };
  const kind = ALERT_KINDS[ep.kind];
  if (!kind) return { action: "stop", reason: "unknown kind" };
  const today = dayKey(now);
  const attemptsToday = ep.attempts_day === today ? ep.attempts_today : 0;
  if (attemptsToday >= settings.num("voice.max_calls_per_day")) return { action: "wait", reason: "daily limit" };
  if (ep.last_attempt_at && now.getTime() - Date.parse(ep.last_attempt_at) < settings.num("voice.min_gap_minutes") * 60_000) return { action: "wait", reason: "too soon after the last attempt" };
  const hour = zoned(now).hour;
  if (!kind.urgent && (hour >= settings.num("voice.quiet_from_hour") || hour < settings.num("voice.quiet_until_hour"))) return { action: "wait", reason: "quiet hours" };
  if (opts.budgetCapped) return { action: "telegram_only", reason: "the monthly voice limit is reached" };
  return { action: "call" };
}

// ---- how a finished call went
export type CallOutcome = "answered" | "voicemail" | "unanswered";

/** From Vapi's endedReason (and how long it lasted): did I pick up, or did it go to voicemail / nobody / a failure? */
export function classifyEnd(reason: string | null, durationS: number | null): CallOutcome {
  const r = (reason ?? "").toLowerCase();
  if (r === "voicemail" || r.includes("voicemail")) return "voicemail";
  if (/did-not-answer|no-answer|busy|rejected|declined|unallocated|failed|error|unavailable|timed-out-before|silence-timed-out/.test(r)) return "unanswered";
  if (!r && (durationS ?? 0) < 4) return "unanswered";
  return "answered";
}

// ---- episodes
export const getEpisode = (db: Database.Database, id: number) => db.prepare(`SELECT * FROM alert_episodes WHERE id = ?`).get(id) as Episode | undefined;
export const openEpisodes = (db: Database.Database) => db.prepare(`SELECT * FROM alert_episodes WHERE resolved_at IS NULL ORDER BY id`).all() as Episode[];

/** The open episode of this kind, or a new one. The same thing reported twice is one episode. */
export function openEpisode(db: Database.Database, kind: string, now: Date, detail: object = {}): Episode {
  const existing = db.prepare(`SELECT * FROM alert_episodes WHERE kind = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1`).get(kind) as Episode | undefined;
  if (existing) return existing;
  const id = db.prepare(`INSERT INTO alert_episodes (kind, started_at, detail) VALUES (?, ?, ?)`).run(kind, now.toISOString(), JSON.stringify(detail)).lastInsertRowid as number;
  return getEpisode(db, id)!;
}

export function resolveEpisodes(db: Database.Database, kind: string, now: Date): number {
  return db.prepare(`UPDATE alert_episodes SET resolved_at = ? WHERE kind = ? AND resolved_at IS NULL`).run(now.toISOString(), kind).changes;
}

function recordAttempt(db: Database.Database, ep: Episode, now: Date): void {
  const today = dayKey(now);
  db.prepare(`UPDATE alert_episodes SET last_attempt_at = ?, attempts_today = ?, attempts_day = ? WHERE id = ?`).run(now.toISOString(), (ep.attempts_day === today ? ep.attempts_today : 0) + 1, today, ep.id);
}

// ---- the run
export interface AlertDeps {
  db: Database.Database;
  now: () => Date;
  enabled: boolean;
  ownerPhone: string | undefined;
  capUsd: number | (() => number);
  /** Seconds the garage must be open before it counts as left open (default: the setting). */
  openAfterSeconds?: number;
  /** The garage as it is right now, or an error. */
  garage: () => Promise<GarageReading>;
  /** Phone me (the alert said aloud once I pick up). Resolves to the Vapi call id. */
  placeCall: (opts: { alert: string }) => Promise<string>;
  notify: (text: string, options?: { canWait?: boolean; dedupeKey?: string; cooldownMs?: number }) => unknown;
  log?: (m: string) => void;
}

const minutesText = (ms: number) => spokenDuration(ms);

/**
 * Look at the garage and act: open an episode when it has been open 10 minutes, end it when it closes, and for every open
 * episode do what decide() says. Called by the watchdog every 5 minutes and by the Home Assistant webhook. Never throws.
 */
export async function runAlerts(deps: AlertDeps): Promise<string[]> {
  const now = deps.now();
  const log = deps.log ?? (() => {});
  const did: string[] = [];
  if (!deps.enabled) return did;

  let reading: GarageReading;
  try {
    reading = await deps.garage();
  } catch (err) {
    log(`could not read the garage: ${(err as Error).message}`);
    return did;
  }
  // An unreadable garage changes nothing: it is neither "open" nor "fixed".
  if (reading.state === "unavailable") return did;

  const openLongEnough = reading.state === "open" && reading.sinceMs !== null && reading.sinceMs >= (deps.openAfterSeconds ?? settings.num("voice.garage_open_seconds")) * 1000;
  if (openLongEnough) openEpisode(deps.db, "garage_open", now, { open_since: new Date(now.getTime() - (reading.sinceMs ?? 0)).toISOString() });
  else if (reading.state === "closed" && resolveEpisodes(deps.db, "garage_open", now)) did.push("garage_open: resolved");

  for (const ep of openEpisodes(deps.db)) {
    const stillActive = ep.kind === "garage_open" ? reading.state === "open" || reading.state === "opening" || reading.state === "closing" : true;
    const decision = decide(ep, now, { stillActive, budgetCapped: budget(deps.db, now, typeof deps.capUsd === "function" ? deps.capUsd() : deps.capUsd).level === "capped" });
    if (decision.action === "stop") {
      if (decision.reason !== "resolved") resolveEpisodes(deps.db, ep.kind, now);
      continue;
    }
    if (decision.action === "wait") continue;

    const open = reading.sinceMs ?? 0;
    const text = `the garage has been open for ${minutesText(open)}`;
    recordAttempt(deps.db, ep, now);
    if (decision.action === "telegram_only") {
      deps.notify(`🚨 The ${text}. I didn't phone because ${decision.reason}.`);
      did.push(`${ep.kind}: telegram only`);
      continue;
    }
    // The call is recorded BEFORE it is placed, so a tool call from it is only ever accepted for a call Jarvis made.
    const pending = `pending-${ep.id}-${now.getTime()}`;
    registerCall(deps.db, { id: pending, direction: "outbound", number: deps.ownerPhone ?? null, alertEpisodeId: ep.id }, now);
    try {
      const callId = await deps.placeCall({ alert: text });
      renameCall(deps.db, pending, callId);
      did.push(`${ep.kind}: phoned`);
      log(`phoned about ${ep.kind}`);
    } catch (err) {
      deps.db.prepare(`DELETE FROM voice_calls WHERE call_id = ?`).run(pending);
      deps.notify(`🚨 The ${text}. I tried to phone you but the call didn't go through.`);
      did.push(`${ep.kind}: call failed, telegram sent`);
      log(`could not place the call: ${(err as Error).message}`);
    }
  }
  return did;
}

/** A call has finished. If it was an alert call and I did not pick up (or it was voicemail), tell me on Telegram instead. */
export function handleCallEnded(deps: Pick<AlertDeps, "db" | "notify" | "now">, call: CallRow): void {
  if (call.direction !== "outbound" || call.alert_episode_id === null) return;
  const ep = getEpisode(deps.db, call.alert_episode_id);
  if (!ep || ep.resolved_at) return; // fixed in the meantime: nothing more to say
  const outcome = classifyEnd(call.ended_reason, call.duration_s);
  if (outcome === "answered") return;
  const since = (() => {
    try {
      const open = (JSON.parse(ep.detail ?? "{}") as { open_since?: string }).open_since;
      return open ? deps.now().getTime() - Date.parse(open) : null;
    } catch {
      return null;
    }
  })();
  const how = outcome === "voicemail" ? "it went to voicemail" : "you didn't pick up";
  const what = ep.kind === "garage_open" ? `The garage has been open${since ? ` for ${minutesText(since)}` : ""} and is still open.` : "Something needs your attention.";
  deps.notify(`🚨 ${what} I phoned you but ${how}.`);
}

