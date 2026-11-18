import { MONTHLY_SPEND_CAP_USD, DAILY_CALL_CAP } from "../ai/settings";
import { config } from "../config";
import { LOOKBACK_DAYS, MAX_EMAILS_PER_RUN, MIN_CONFIDENCE } from "../gmail/settings";
import { PEOPLE } from "../location/store";
import { CALENDAR_CREATES_PER_DAY, CALENDAR_MIN_CONFIDENCE, DEFAULT_EVENT_HOURS, ARCHIVE_AFTER_DAYS, MAX_PHOTOS_IN_DM, MIN_CREATE_CONFIDENCE } from "../plans/settings";
import { LIKE_BATCH, PLAY_THRESHOLD, WINDOW_DAYS } from "../spotify/settings";
import { lightsToText, loadEntities, parseLightLines } from "../voice/entities";

// Every setting I can change on the dashboard: its page (group), label, limits and default. The default is the value that used to
// be written into the code. Add a setting here, read it with settings.num/bool/str("key"), and it appears on its page.

export type Group = "ai" | "spotify" | "plans" | "gmail" | "voice" | "home";
type Dflt<T> = T | (() => T);
interface Base {
  group: Group;
  label: string;
  help: string;
  unit?: string;
}
export type Def = Base &
  (
    | { type: "number"; default: Dflt<number>; min: number; max: number; step?: number; int?: boolean }
    | { type: "bool"; default: Dflt<boolean> }
    | { type: "choice"; default: Dflt<string>; choices: string[] }
    | { type: "lines"; default: Dflt<string>; maxLength?: number; check?: (text: string) => string | null }
  );

export const GROUPS: Record<Group, { title: string; blurb: string }> = {
  ai: { title: "AI spend", blurb: "Limits on what the AI may cost." },
  spotify: { title: "Spotify settings", blurb: "When a track gets liked." },
  plans: { title: "Plans settings", blurb: "How sure Jarvis must be, and how it paces itself." },
  gmail: { title: "Invoice email settings", blurb: "How Jarvis reads receipts from Gmail." },
  voice: { title: "Voice settings", blurb: "Spend, alert calls and quiet hours." },
  home: { title: "Home Assistant settings", blurb: "The garage, who triggers what, and the lights voice may switch." },
};

const num = (group: Group, label: string, help: string, def: Dflt<number>, min: number, max: number, extra: { unit?: string; step?: number; int?: boolean } = {}): Def => ({ group, label, help, type: "number", default: def, min, max, ...extra });

const personal = Object.fromEntries(
  PEOPLE.flatMap(({ key, name }) => [
    [`location.open_on_arrive.${key}`, { group: "home", type: "bool", label: `Open the garage when ${name} gets home`, help: "Only if it is closed.", default: key === "me" } satisfies Def],
    [`location.close_on_leave.${key}`, { group: "home", type: "bool", label: `Close the garage after ${name} leaves`, help: "Only a door opened in the last few minutes (below).", default: true } satisfies Def],
    [`location.telegram.${key}`, { group: "home", type: "bool", label: `Telegram me when ${name} comes and goes`, help: "Messages about the garage opening or closing for them.", default: key === "me" } satisfies Def],
  ]),
) as Record<string, Def>;

export const DEFS: Record<string, Def> = {
  // ---- AI
  "ai.monthly_cap_usd": num("ai", "Monthly AI spend limit", "The AI stops at this amount each month (Telegram warns at 80%).", MONTHLY_SPEND_CAP_USD, 1, 1000, { unit: "US$", step: 1 }),
  "ai.daily_call_cap": num("ai", "AI calls a day", "At most this many AI calls per day.", DAILY_CALL_CAP, 1, 100000, { int: true }),

  // ---- Spotify
  "spotify.play_threshold": num("spotify", "Like a track played more than", "A track played MORE than this many times in the window gets liked (4 means 5 plays).", PLAY_THRESHOLD, 1, 100, { unit: "plays", int: true }),
  "spotify.window_days": num("spotify", "…within the last", "The window the plays are counted in.", WINDOW_DAYS, 1, 60, { unit: "days", int: true }),
  "spotify.like_batch": num("spotify", "Tracks checked or liked per request", "Spotify's API takes tracks in batches.", LIKE_BATCH, 1, 50, { int: true }),

  // ---- Plans
  "plans.min_create_confidence": num("plans", "Smallest confidence to create a plan", "Below this the AI's find is ignored (0 to 1).", MIN_CREATE_CONFIDENCE, 0, 1, { step: 0.05 }),
  "plans.calendar_min_confidence": num("plans", "Smallest confidence to add it to the calendar", "A plan must be at least this sure (0 to 1).", CALENDAR_MIN_CONFIDENCE, 0, 1, { step: 0.05 }),
  "plans.quiet_minutes": num("plans", "Wait for a chat to go quiet", "Jarvis reads a chat once it has been quiet this long.", 3, 1, 120, { unit: "minutes", int: true }),
  "plans.force_after_minutes": num("plans", "…but never wait longer than", "A busy chat is read after this long anyway.", 30, 5, 600, { unit: "minutes", int: true }),
  "plans.default_event_hours": num("plans", "Calendar event length when no end time", "", DEFAULT_EVENT_HOURS, 0.5, 24, { unit: "hours", step: 0.5 }),
  "plans.calendar_creates_per_day": num("plans", "New calendar events a day", "A safety limit.", CALENDAR_CREATES_PER_DAY, 1, 100, { int: true }),
  "plans.archive_after_days": num("plans", "Archive finished plans after", "", ARCHIVE_AFTER_DAYS, 1, 365, { unit: "days", int: true }),
  "plans.max_photos_in_dm": num("plans", "Read photos in a DM if at most", "More photos than this in one chat are ignored.", MAX_PHOTOS_IN_DM, 1, 20, { int: true }),

  // ---- Invoice emails
  "gmail.lookback_days": num("gmail", "Look back", "How far back each run searches for receipts.", LOOKBACK_DAYS, 1, 60, { unit: "days", int: true }),
  "gmail.max_emails_per_run": num("gmail", "Emails read per run", "", MAX_EMAILS_PER_RUN, 1, 200, { int: true }),
  "gmail.min_confidence": num("gmail", "Smallest confidence to record a receipt", "0 to 1.", MIN_CONFIDENCE, 0, 1, { step: 0.05 }),

  // ---- Voice
  "voice.monthly_cap_usd": num("voice", "Monthly voice limit", "At 100% no outbound calls and the phone tools refuse (Telegram warns at 80%).", () => config.VOICE_MONTHLY_CAP_USD, 1, 1000, { unit: "US$" }),
  "voice.garage_open_seconds": num("voice", "Phone me when the garage has been open", "Jarvis rings once the door has been open this long.", 600, 10, 86400, { unit: "seconds", int: true }),
  "voice.min_gap_minutes": num("voice", "Gap between alert calls", "At least this long between two calls about the same thing.", 30, 1, 1440, { unit: "minutes", int: true }),
  "voice.max_calls_per_day": num("voice", "Alert calls a day", "For each kind of alert.", 3, 1, 50, { int: true }),
  "voice.quiet_from_hour": num("voice", "Quiet hours start", "Non-urgent calls wait. The garage alert is urgent and ignores this.", 23, 0, 23, { unit: "o'clock", int: true }),
  "voice.quiet_until_hour": num("voice", "Quiet hours end", "", 7, 0, 23, { unit: "o'clock", int: true }),
  "voice.alert_call_max_seconds": num("voice", "Longest alert call", "", 180, 30, 1800, { unit: "seconds", int: true }),

  // ---- Home Assistant
  "voice.ha_writes": { group: "home", type: "choice", label: "Voice changes Home Assistant", help: "dry: the phone assistant says what it would do and changes nothing. live: it really does it.", default: () => config.VOICE_HA_WRITES, choices: ["dry", "live"] },
  "location.leave_wait_seconds": num("home", "After someone leaves, wait", "Then check the garage.", 60, 5, 600, { unit: "seconds", int: true }),
  "location.left_open_minutes": num("home", "…close it if it was opened in the last", "A door open longer than this was opened on purpose.", 3, 1, 60, { unit: "minutes", int: true }),
  ...personal,
  "home.voice_lights": {
    group: "home",
    type: "lines",
    label: "Lights the phone assistant can switch",
    help: "One per line: name | switch.entity | alias, alias. The Frontyard Top Lights circuit is refused here and can never be added.",
    default: () => lightsToText(loadEntities().lights),
    maxLength: 4000,
    check: (text) => {
      try {
        parseLightLines(text);
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    },
  },
};
