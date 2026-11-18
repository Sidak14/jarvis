import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const ROOT = path.resolve(__dirname, "..");
// Listens on this Mac AND the home network, so the fridge can open http://<this Mac>:8080/dashboard without Cloudflare.
// A device on the home network can reach ONLY /dashboard (app.ts refuses everything else); the router must not forward port 8080.
export const HOST = "0.0.0.0";

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

  // Home Assistant (local, on this Mac). Optional: without a token the fridge page cannot show or switch lights.
  HA_URL: z.url().default("http://127.0.0.1:8123"),
  HA_TOKEN: z.string().min(1).optional(),
  // The home screen (/dashboard, the kitchen fridge). Who may open it through the Cloudflare tunnel: the emails Cloudflare Access
  // logged in (comma separated). Anyone on the home network can open it directly, with no login (see src/fridge/access.ts). Unset = tunnel logins are refused.
  DASHBOARD_EMAILS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)),

  // Voice: phone calls with Jarvis through Vapi + Twilio (see README "Voice"). Everything here is optional until you set it up.
  VOICE_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  VAPI_API_KEY: z.string().min(10).optional(),
  VAPI_PHONE_NUMBER_ID: z.string().min(10).optional(),
  /** Vapi sends this as "Authorization: Bearer <secret>" to /voice/*. At least 32 characters. */
  VAPI_WEBHOOK_SECRET: z.string().min(32, "must be at least 32 characters").optional(),
  /** Optional: id of a Bearer-token credential made in the Vapi dashboard. Without it the secret is sent as a header Vapi stores. */
  VAPI_CREDENTIAL_ID: z.string().min(5).optional(),
  /** My phone number, E.164 (+614...). The only number Jarvis will talk to (and call). */
  OWNER_PHONE: z.string().regex(/^\+\d{8,15}$/, "must look like +61405123456").optional(),
  /** The words that unlock opening the garage by voice ("open sesame"). Plain text; without it voice can never open the door. */
  VOICE_OPEN_PHRASE: z.string().min(3).optional(),
  /** How long the garage must be open before Jarvis phones. 600 (10 minutes) normally; lower it only to test. */
  VOICE_GARAGE_OPEN_SECONDS: z.coerce.number().int().min(10).default(600),
  VOICE_MONTHLY_CAP_USD: z.coerce.number().positive().default(10),
  /** dry = the voice tools say what they would do to Home Assistant but change nothing. */
  VOICE_HA_WRITES: z.enum(["dry", "live"]).default("dry"),
  /** The path Vapi calls: /voice/* works only if Cloudflare lets it through; /webhook/voice/* is covered by the existing webhook bypass. */
  VOICE_PATH_PREFIX: z.string().regex(/^\/[a-z/]+$/).default("/webhook/voice"),

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
    HA_TOKEN: config.HA_TOKEN ? "***" : undefined,
    VAPI_API_KEY: config.VAPI_API_KEY ? "***" : undefined,
    VAPI_WEBHOOK_SECRET: config.VAPI_WEBHOOK_SECRET ? "***" : undefined,
    VAPI_CREDENTIAL_ID: config.VAPI_CREDENTIAL_ID ? "***" : undefined,
    OWNER_PHONE: config.OWNER_PHONE ? "***" : undefined,
    VOICE_OPEN_PHRASE: config.VOICE_OPEN_PHRASE ? "***" : undefined,
    DASHBOARD_EMAILS: config.DASHBOARD_EMAILS.length ? `${config.DASHBOARD_EMAILS.length} email(s)` : "none",
  };
}
