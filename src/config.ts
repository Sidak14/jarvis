import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const ROOT = path.resolve(__dirname, "..");
export const HOST = "127.0.0.1"; // fixed on purpose: never listen on other interfaces

const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const schema = z.object({
  WEBHOOK_SECRET: z.string().min(16, "must be at least 16 characters"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DB_PATH: z.string().min(1).default(path.join(ROOT, "data", "jarvis.db")),
  // Public hostname of the Cloudflare tunnel (used to accept dashboard requests from it).
  PUBLIC_HOST: z.string().min(1).default("jarvis.gurveerkhalsa.com"),

  // Spotify. Optional so the server still starts before you add them;
  // the spotify-likes job reports a clear error until they are set.
  SPOTIFY_CLIENT_ID: z.string().min(1).optional(),
  SPOTIFY_CLIENT_SECRET: z.string().min(1).optional(),
  // Where Spotify sends the browser after login. Must match one registered in the Spotify
  // dashboard exactly, and end in /spotify/callback.
  // Default: https://<PUBLIC_HOST>/spotify/callback, so login works from any device.
  SPOTIFY_REDIRECT_URI: z
    .url()
    .refine((u) => new URL(u).pathname === "/spotify/callback", "must end with /spotify/callback")
    .optional(),
  // Gmail (read-only) for expenses from invoice emails. Optional until set up.
  GMAIL_CLIENT_ID: z.string().min(1).optional(),
  GMAIL_CLIENT_SECRET: z.string().min(1).optional(),
  // Where Google sends the browser after login; must be registered in Google Cloud exactly.
  // Default: https://<PUBLIC_HOST>/gmail/callback
  GMAIL_REDIRECT_URI: z
    .url()
    .refine((u) => new URL(u).pathname === "/gmail/callback", "must end with /gmail/callback")
    .optional(),
  // Safe by default: log what would be added, write no expenses.
  GMAIL_DRY_RUN: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Vercel AI Gateway key, used to read invoice emails with an LLM.
  AI_GATEWAY_API_KEY: z.string().min(1).optional(),

  // Telegram bot (chat interface). Optional: without both, messages wait in the outbox.
  TELEGRAM_BOT_TOKEN: z.string().min(20).optional(),
  // Only this Telegram user is ever answered. Unset: /start replies with your id once.
  TELEGRAM_OWNER_ID: z.coerce.number().int().positive().optional(),
  // Off until you have received the test message and say so.
  TELEGRAM_QUESTIONS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Set to 7 while the Google OAuth app is in "Testing" (Google expires the login then), so an
  // alert warns before it does. Leave unset once the app is in production.
  GMAIL_CONSENT_DAYS: z.coerce.number().int().positive().optional(),

  // Plans: Beeper Desktop's local API (read-only) + Google Calendar. Optional until set up.
  BEEPER_ACCESS_TOKEN: z.string().min(10).optional(),
  BEEPER_BASE_URL: z.url().default("http://127.0.0.1:23373"),
  // Safe by default: read, detect and write plans.md, but never touch the calendar or send pings.
  PLANS_DRY_RUN: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Read every chat instead of only the allowlist (DMs still go through the cheap prefilter).
  PLANS_ALL_CHATS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // For testing: on the very first start, also read the last 7 days of allowlisted chats.
  PLANS_BACKFILL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Where Google sends the browser after the Calendar login (registered in Google Cloud).
  // Default: https://<PUBLIC_HOST>/calendar/callback. Uses the same client id/secret as Gmail.
  CALENDAR_REDIRECT_URI: z
    .url()
    .refine((u) => new URL(u).pathname === "/calendar/callback", "must end with /calendar/callback")
    .optional(),

  // Google Sheets for expenses. Optional: without them expenses are stored and the sync waits.
  GOOGLE_SHEET_ID: z.string().min(1).optional(),
  // Path to the service account's JSON key (outside git, chmod 600).
  GOOGLE_SERVICE_ACCOUNT_FILE: z.string().min(1).optional().transform((v) => (v ? path.resolve(ROOT, v) : v)),
  GOOGLE_SHEET_TAB: z.string().min(1).default("Sheet1"),
  // Safe by default: log what would be liked, but don't like anything.
  SPOTIFY_DRY_RUN: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Print only which keys are wrong and why. Never echo the values.
  for (const issue of parsed.error.issues) {
    console.error(`config error: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = {
  ...parsed.data,
  SPOTIFY_REDIRECT_URI:
    parsed.data.SPOTIFY_REDIRECT_URI ?? `https://${parsed.data.PUBLIC_HOST}/spotify/callback`,
  GMAIL_REDIRECT_URI:
    parsed.data.GMAIL_REDIRECT_URI ?? `https://${parsed.data.PUBLIC_HOST}/gmail/callback`,
  CALENDAR_REDIRECT_URI:
    parsed.data.CALENDAR_REDIRECT_URI ?? `https://${parsed.data.PUBLIC_HOST}/calendar/callback`,
};

/** Safe-to-log view of the config: secrets are masked. */
export function redactedConfig(): Record<string, string | number | boolean | undefined> {
  return {
    ...config,
    WEBHOOK_SECRET: "***",
    SPOTIFY_CLIENT_ID: config.SPOTIFY_CLIENT_ID ? "***" : undefined,
    SPOTIFY_CLIENT_SECRET: config.SPOTIFY_CLIENT_SECRET ? "***" : undefined,
    GOOGLE_SHEET_ID: config.GOOGLE_SHEET_ID ? "***" : undefined,
    GMAIL_CLIENT_ID: config.GMAIL_CLIENT_ID ? "***" : undefined,
    GMAIL_CLIENT_SECRET: config.GMAIL_CLIENT_SECRET ? "***" : undefined,
    AI_GATEWAY_API_KEY: config.AI_GATEWAY_API_KEY ? "***" : undefined,
    BEEPER_ACCESS_TOKEN: config.BEEPER_ACCESS_TOKEN ? "***" : undefined,
    TELEGRAM_BOT_TOKEN: config.TELEGRAM_BOT_TOKEN ? "***" : undefined,
    TELEGRAM_OWNER_ID: config.TELEGRAM_OWNER_ID ? "***" : undefined,
  };
}
