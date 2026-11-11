// Telegram: every knob in one place.

export const TIMEZONE = "Australia/Sydney";

// ---- Notifications: nothing that can wait is sent outside these hours (Sydney time)
export const NOTIFY_START_MINUTE = 9 * 60;
export const NOTIFY_END_MINUTE = 23 * 60;

// ---- Categorising expenses (AI first, then asking the owner)
export const CATEGORISE_JOB = "expenses-categorise";
/** The safety-net sweep: 9pm Sydney every day. New expenses are categorised right away anyway. */
export const CATEGORISE_CRON = "0 21 * * *";
/** After this many failed AI calls for one expense, ask the owner instead. */
export const CATEGORISE_MAX_ATTEMPTS = 3;
/** What the AI is shown: the last few expenses from the same merchant... */
export const HISTORY_PER_MERCHANT = 5;
/** ...and everything logged in the 12 hours before this expense. */
export const CONTEXT_WINDOW_MS = 12 * 60 * 60 * 1000;
export const CONTEXT_MAX_ROWS = 30;
/** If a merchant's last this-many categories all agree, reuse that category without asking the AI. */
export const REPEAT_MERCHANT_MATCHES = 5;
/** Expenses older than this are categorised quietly: if the AI is unsure we do not message about them. */
export const ASK_MAX_AGE_DAYS = 2;

/** The numbered answers, in the order they are shown. Skip is always the number after the last one. */
export const CATEGORIES = [
  { label: "Food and drinks" },
  { label: "Groceries" },
  { label: "Transport" },
  { label: "Fun" },
  { label: "Bills" },
  { label: "Other" },
] as const;
export const SKIP_NUMBER = CATEGORIES.length + 1;

// ---- /log (typing an expense in by hand)
export const LOG_MAX_AMOUNT_CENTS = 10_000_000; // 100,000.00
export const LOG_MAX_AGE_DAYS = 400;

// ---- What the owner can send us
export const MAX_INCOMING_CHARS = 500;
export const MAX_PURPOSE_CHARS = 200;
export const INCOMING_PER_MINUTE = 20;
export const POLL_TIMEOUT_SECONDS = 25;

// ---- Outbox
export const OUTBOX_JOB = "telegram-outbox";
export const OUTBOX_CRON = "* * * * *"; // every minute
export const OUTBOX_BATCH = 20;
/** After this many failed attempts a message is marked 'failed' (shown on the status page). */
export const OUTBOX_MAX_ATTEMPTS = 50;
/** Minutes to wait after the 1st, 2nd, 3rd... failed attempt (the last value repeats). */
export const BACKOFF_MINUTES = [1, 2, 4, 8, 15, 30, 60];
export const MAX_MESSAGE_CHARS = 4000; // Telegram's limit is 4096

// ---- Monthly recap: runs daily at 9am Sydney and sends last month's recap once
export const RECAP_JOB = "telegram-recap";
export const RECAP_CRON = "0 9 * * *";
/** If the Mac was off on the 1st, still send during the first few days. */
export const RECAP_CATCHUP_DAYS = 3;

// ---- Alerts
export const ALERTS_JOB = "health-alerts";
export const ALERTS_CRON = "*/10 * * * *";
export const SHEET_STUCK_AFTER_MS = 60 * 60 * 1000;
export const SHEET_ERROR_ATTEMPTS = 3;
export const JOB_FAILURE_STREAK = 3;
export const AI_WARN_FRACTION = 0.8;
export const CONSENT_WARN_DAYS = 14;
const HOUR = 60 * 60 * 1000;
export const COOLDOWN = {
  sheet: 6 * HOUR,
  gmail: 12 * HOUR,
  consent: 24 * HOUR,
  ai: 24 * HOUR,
  ai80: 32 * 24 * HOUR, // once a month
  job: 6 * HOUR,
} as const;
