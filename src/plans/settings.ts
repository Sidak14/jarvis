// Plans: every knob in one place.

export const TIMEZONE = "Australia/Sydney";

export const POLL_JOB = "plans-poll";
export const POLL_CRON = "*/5 * * * *"; // reading new messages is local and free

// ---- When a chat is sent to the model
/** Run detection once the chat has been quiet this long... */
export const QUIET_MS = 3 * 60 * 1000;
/** ...or, if it never goes quiet, once the oldest unprocessed message is this old. */
export const FORCE_AFTER_MS = 30 * 60 * 1000;
/** Most messages in one model call; the rest wait for the next run. */
export const BATCH_MAX_MESSAGES = 60;
/** After this many failed model calls a batch's messages are given up on. */
export const MAX_DETECT_ATTEMPTS = 3;

// ---- Reading Beeper
export const CHATS_PAGE_LIMIT = 200;
/** Only chats on these Beeper bridges are ever read (account ids look like "instagramgo.123"). */
export const ALLOWED_BRIDGES = ["instagramgo"];
/** Chats looked through to find the allowed ones (the Server also holds Slack, WhatsApp...). */
export const CHATS_SCAN_LIMIT = 1500;
/** Messages this old are not re-read (reactions to older messages are not noticed). */
export const RESCAN_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
export const MAX_PAGES_PER_CHAT = 4;
/** Group member lists are refreshed this often. */
export const MEMBERS_REFRESH_MS = 60 * 60 * 1000;
export const BACKFILL_DAYS = 7;
/** Processed message ids are kept this long (so they are never processed twice), then pruned. */
export const KEEP_MESSAGE_IDS_DAYS = 30;
export const MAX_TEXT_CHARS = 1000; // per message sent to the model

// ---- What the model is shown
export const PLANS_UPCOMING_DAYS = 30;
export const PLANS_RECENT_DAYS = 14;
export const PLANS_IN_PROMPT = 30;
/** A DM sender who is in a chat with an open plan this soon is let through the prefilter. */
export const OPEN_PLAN_DM_DAYS = 14;
export const CALENDAR_TABLE_DAYS = 21;

// ---- Checking what the model says
export const MAX_RESULTS_PER_BATCH = 5;
export const MIN_CREATE_CONFIDENCE = 0.6;
export const CALENDAR_MIN_CONFIDENCE = 0.7;
/** A link to a plan in another chat is only acted on at or above this. */
export const LINK_HIGH = 0.8;
/** Between this and LINK_HIGH it is stored as a "possible link" for the dashboard. */
export const LINK_POSSIBLE = 0.4;
/** With two plans on the same day, a link must be at least this sure, else it is only "possible". */
export const LINK_SAME_DAY_HIGH = 0.95;
/** A sender who is not in the plan's chat needs this much confidence to link. */
export const LINK_OUTSIDER = 0.9;
export const MAX_DATE_FUTURE_DAYS = 365;
export const MAX_DATE_PAST_DAYS = 14;

// ---- Files
export const PLANS_FILE = "plans.md";
export const ARCHIVE_FILE = "plans-archive.md";
export const ALLOWLIST_FILE = "plans-chats.json";
/** Plans this long past their date move to the archive. */
export const ARCHIVE_AFTER_DAYS = 14;

// ---- Actions
export const DEFAULT_EVENT_HOURS = 2;
export const CALENDAR_CREATES_PER_DAY = 5;
export const COOLDOWN_BEEPER_MS = 6 * 60 * 60 * 1000;
export const COOLDOWN_CALENDAR_MS = 12 * 60 * 60 * 1000;
