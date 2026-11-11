import { config } from "../config";
import { db } from "../db";
import { createTelegramApi } from "./api";
import { createOutbox } from "./outbox";
import { attachQuestionMessage } from "./questions";

/** The Telegram API client, or null until TELEGRAM_BOT_TOKEN is set. */
export const telegramApi = config.TELEGRAM_BOT_TOKEN ? createTelegramApi({ token: config.TELEGRAM_BOT_TOKEN, db }) : null;

const owner = config.TELEGRAM_OWNER_ID;

/** The one outbox for the whole server. Without a token and owner id, messages wait in it. */
export const outbox = createOutbox({
  db,
  send: telegramApi && owner !== undefined ? (text, options) => telegramApi.sendMessage(owner, text, options) : null,
  onSent: (row, messageId) => {
    // A question was delivered: remember which message asked about which expense.
    if (row.kind === "expense_question" && row.ref) attachQuestionMessage(db, Number(row.ref), messageId);
  },
  log: (m) => console.log(`[telegram] ${m}`),
});

/** Send the owner a message. Saved to the outbox first, so it is never lost. Used by every job. */
export const notify = outbox.notify;
