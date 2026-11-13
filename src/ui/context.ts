import { config } from "../config";
import { db } from "../db";
import { gmailAuth } from "../gmail/index";
import { calendarAuth } from "../plans/index";
import { listRegisteredJobs } from "../runner";
import { spotifyAuth } from "../spotify/index";
import type { UiContext } from "./vm/types";

/** The live context the pages are built from: the real database, config flags, logins and scheduler. */
export function liveContext(now = new Date()): UiContext {
  return {
    db,
    now,
    registered: listRegisteredJobs(),
    flags: {
      sheetConfigured: Boolean(config.GOOGLE_SHEET_ID && config.GOOGLE_SERVICE_ACCOUNT_FILE),
      gmailConfigured: gmailAuth.isConfigured(),
      gmailConnected: gmailAuth.isConnected(),
      gmailDryRun: config.GMAIL_DRY_RUN,
      spotifyConfigured: spotifyAuth.isConfigured(),
      spotifyConnected: spotifyAuth.isConnected(),
      spotifyDryRun: config.SPOTIFY_DRY_RUN,
      telegramConfigured: Boolean(config.TELEGRAM_BOT_TOKEN),
      telegramOwnerSet: config.TELEGRAM_OWNER_ID !== undefined,
      telegramQuestions: config.TELEGRAM_QUESTIONS_ENABLED,
      beeperConfigured: Boolean(config.BEEPER_ACCESS_TOKEN),
      beeperBaseUrl: config.BEEPER_BASE_URL,
      plansDryRun: config.PLANS_DRY_RUN,
      plansAllChats: config.PLANS_ALL_CHATS,
      calendarConnected: calendarAuth.isConnected(),
      aiConfigured: Boolean(config.AI_GATEWAY_API_KEY),
    },
  };
}
