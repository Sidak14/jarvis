import type Database from "better-sqlite3";
import { z } from "zod";
import { recordApiCall } from "../spotify/usage";

// A small Telegram Bot API client (plain fetch, like the others). Text is always sent as PLAIN
// text, never Markdown/HTML, so a merchant name can never turn into formatting or a link.
// The bot token is part of every request URL, so it is never put in an error or a log.

export class TelegramError extends Error {
  constructor(message: string, public status?: number, public retryAfter?: number) {
    super(message);
  }
}

export interface Button {
  text: string;
  data: string;
}

// Only the fields we use. Anything unexpected is ignored; an update that does not fit is dropped.
export const updateSchema = z.looseObject({
  update_id: z.number().int(),
  message: z
    .looseObject({
      message_id: z.number().int(),
      text: z.string().optional(),
      chat: z.looseObject({ id: z.number(), type: z.string() }),
      from: z.looseObject({ id: z.number() }).optional(),
      reply_to_message: z.looseObject({ message_id: z.number().int() }).optional(),
    })
    .optional(),
  callback_query: z
    .looseObject({
      id: z.string(),
      from: z.looseObject({ id: z.number() }),
      data: z.string().optional(),
      message: z
        .looseObject({ message_id: z.number().int(), chat: z.looseObject({ id: z.number() }) })
        .optional(),
    })
    .optional(),
});
export type Update = z.infer<typeof updateSchema>;

export interface SendOptions {
  buttons?: Button[][];
  replyTo?: number;
}

export interface TelegramApi {
  getMe(): Promise<{ id: number; username?: string }>;
  getUpdates(offset: number, timeoutSeconds: number): Promise<unknown[]>;
  /** Returns the id of the message that was sent. */
  sendMessage(chatId: number, text: string, options?: SendOptions): Promise<number>;
  answerCallbackQuery(callbackId: string, text?: string): Promise<void>;
  /** Remove the buttons from a message (after it has been answered). */
  clearButtons(chatId: number, messageId: number): Promise<void>;
}

export function createTelegramApi(opts: {
  token: string;
  db: Database.Database;
  fetchFn?: typeof fetch;
}): TelegramApi {
  const { token, db, fetchFn = fetch } = opts;

  async function call<T>(method: string, body: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
    recordApiCall(db, "telegram");
    let res: Response;
    try {
      res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Only the error's name: its message could contain the request URL, and so the token.
      throw new TelegramError(`Telegram ${method}: network error (${(err as Error).name})`);
    }
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!res.ok || !json.ok) {
      const why = String(json.description ?? "").replace(token, "***").slice(0, 150);
      throw new TelegramError(`Telegram ${method} failed: HTTP ${res.status} ${why}`, res.status, json.parameters?.retry_after);
    }
    return json.result as T;
  }

  return {
    getMe: () => call("getMe", {}),
    getUpdates: (offset, timeoutSeconds) =>
      call<unknown[]>(
        "getUpdates",
        { offset, timeout: timeoutSeconds, allowed_updates: ["message", "callback_query"] },
        (timeoutSeconds + 10) * 1000,
      ),
    async sendMessage(chatId, text, options = {}) {
      const result = await call<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        text,
        ...(options.replyTo ? { reply_parameters: { message_id: options.replyTo } } : {}),
        ...(options.buttons
          ? {
              reply_markup: {
                inline_keyboard: options.buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
              },
            }
          : {}),
      });
      return result.message_id;
    },
    async answerCallbackQuery(callbackId, text) {
      await call("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
    },
    async clearButtons(chatId, messageId) {
      await call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    },
  };
}
