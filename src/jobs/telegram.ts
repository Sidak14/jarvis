import { createGatewayLlm } from "../ai/llm";
import { config } from "../config";
import { db } from "../db";
import { registerJob, triggerJob } from "../runner";
import { checkAlerts } from "../telegram/alerts";
import { createRateLimiter, handleUpdate, startPolling } from "../telegram/bot";
import { notify, outbox, telegramApi } from "../telegram";
import { categoriseExpenses } from "../telegram/categorise";
import { sendRecapIfDue } from "../telegram/recap";
import {
  ALERTS_CRON,
  CATEGORISE_CRON,
  CATEGORISE_JOB,
  ALERTS_JOB,
  INCOMING_PER_MINUTE,
  OUTBOX_CRON,
  OUTBOX_JOB,
  RECAP_CRON,
  RECAP_JOB,
  TIMEZONE,
} from "../telegram/settings";
import { getState, setState } from "../telegram/state";
import { SYNC_JOB } from "./expenses";
import { planCommand } from "./plans";

/**
 * The Telegram jobs. These run often, so they are "quiet": a run that did nothing is not
 * written to the run history (a failure always is).
 */
export function registerTelegram(): void {
  // Retry anything that did not send (every minute, with backoff per message).
  registerJob(
    OUTBOX_JOB,
    OUTBOX_CRON,
    async ({ log }) => {
      const r = await outbox.flush();
      if (r.sent || r.failed) log(`sent ${r.sent}, failed ${r.failed}`);
    },
    { quiet: true },
  );

  // Categorise new expenses (AI), and ask on Telegram about the ones it is unsure of. The webhook
  // and Gmail jobs start this right after saving an expense; this 9pm run is the safety net.
  // Off until TELEGRAM_QUESTIONS_ENABLED=true (after the test message).
  registerJob(
    CATEGORISE_JOB,
    CATEGORISE_CRON,
    async ({ log }) => {
      if (!config.TELEGRAM_QUESTIONS_ENABLED || !telegramApi || config.TELEGRAM_OWNER_ID === undefined) return;
      const llm = config.AI_GATEWAY_API_KEY ? createGatewayLlm({ apiKey: config.AI_GATEWAY_API_KEY, db }) : null;
      await categoriseExpenses({ db, llm, notify, onCategorised: () => triggerJob(SYNC_JOB), log });
    },
    { timezone: TIMEZONE, quiet: true },
  );

  // Last month's recap: daily at 9am Sydney, sent once per month.
  registerJob(
    RECAP_JOB,
    RECAP_CRON,
    ({ log }) => {
      const result = sendRecapIfDue({ db, notify });
      if (result === "sent" || result === "empty") log(`monthly recap: ${result}`);
    },
    { timezone: TIMEZONE, quiet: true },
  );

  // Look for quiet failures and say so.
  registerJob(
    ALERTS_JOB,
    ALERTS_CRON,
    ({ log }) => {
      const raised = checkAlerts({ db, notify });
      if (raised.length) log(`alerts sent: ${raised.join(", ")}`);
    },
    { quiet: true },
  );
}

/** Start long polling for the owner's messages. Returns a function that stops it. */
export function startTelegramBot(): () => void {
  if (!telegramApi) {
    console.log("[telegram] no TELEGRAM_BOT_TOKEN: the bot is off, messages wait in the outbox");
    return () => {};
  }
  const api = telegramApi; // (narrowed: not null from here on)
  const log = (m: string) => console.log(`[telegram] ${m}`);
  const limiter = createRateLimiter(INCOMING_PER_MINUTE, 60_000);

  // One test message, before anything else is switched on.
  if (config.TELEGRAM_OWNER_ID !== undefined && getState(db, "test_message_queued") === null) {
    notify(
      "✅ Jarvis test message. If you can read this, Telegram is wired up.\nExpense questions are OFF until you set TELEGRAM_QUESTIONS_ENABLED=true in .env and restart. Try /help.",
    );
    setState(db, "test_message_queued", new Date().toISOString());
  }

  return startPolling({
    db,
    api,
    log,
    handle: (raw) =>
      handleUpdate(
        {
          db,
          ownerId: config.TELEGRAM_OWNER_ID,
          api,
          notify,
          limiter,
          onLabelled: () => triggerJob(SYNC_JOB), // push the new Category/Purpose to the Sheet soon
          llm: config.AI_GATEWAY_API_KEY ? createGatewayLlm({ apiKey: config.AI_GATEWAY_API_KEY, db }) : null,
          planCommand,
          onLogged: () => {
            triggerJob(SYNC_JOB);
            triggerJob(CATEGORISE_JOB);
          },
          log,
        },
        raw,
      ),
  });
}
