import type Database from "better-sqlite3";
import { AiCapError, LlmError, type Llm } from "../ai/llm";
import { LlmJsonError } from "../ai/json";
import { updateSchema, type TelegramApi } from "./api";
import { money } from "./format";
import { runCommand } from "./commands";
import { insertManualExpense, LOG_USAGE, parseLog } from "./log";
import type { Outbox } from "./outbox";
import { applyReply, findExpenseByQuestionMessage, recategorise } from "./questions";
import { CATEGORIES, INCOMING_PER_MINUTE, MAX_INCOMING_CHARS, POLL_TIMEOUT_SECONDS, SKIP_NUMBER } from "./settings";
import { bumpState, getState, setState } from "./state";
import { formatWhen } from "./time";

// The bot talks to ONE person: the owner. Every update from anyone else is dropped silently.
// What the owner types is data. The only things it can do are: run one of a short list of fixed
// commands, change a category with /recat, or answer a question (a number, or text stored as data).

export interface RateLimiter {
  allow(): boolean;
}
export function createRateLimiter(max: number, windowMs: number, clock: () => number = Date.now): RateLimiter {
  const hits: number[] = [];
  return {
    allow() {
      const now = clock();
      while (hits.length && now - hits[0] >= windowMs) hits.shift();
      if (hits.length >= max) return false;
      hits.push(now);
      return true;
    },
  };
}

export interface BotDeps {
  db: Database.Database;
  /** undefined until the owner's id is put in .env: then /start replies with the sender's id, once. */
  ownerId: number | undefined;
  api: Pick<TelegramApi, "sendMessage" | "answerCallbackQuery" | "clearButtons">;
  notify: Outbox["notify"];
  limiter: RateLimiter;
  /** Called after an answer is saved, so the Sheet can be updated soon. */
  onLabelled?: () => void;
  /** Reads /log messages. null when AI is not set up. */
  llm?: Llm | null;
  /** Called after /log saved an expense (sync it to the Sheet, categorise it). */
  onLogged?: () => void;
  now?: () => Date;
  log?: (message: string) => void;
}

const COMMAND_WORD = /^\/[A-Za-z_]+/;

export async function handleUpdate(deps: BotDeps, raw: unknown): Promise<void> {
  const { db, ownerId, api, notify } = deps;
  const log = deps.log ?? (() => {});
  const now = (deps.now ?? (() => new Date()))();

  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return;
  const update = parsed.data;
  const senderId = update.message?.from?.id ?? update.callback_query?.from?.id;
  if (senderId === undefined) return;

  // First-run helper: no owner configured yet. Tell whoever sends /start their id, once, and do nothing else.
  if (ownerId === undefined) {
    const text = update.message?.text?.trim() ?? "";
    if (update.message && /^\/start(@\w+)?$/i.test(text) && getState(db, "owner_hint_sent") === null) {
      setState(db, "owner_hint_sent", "1", now);
      await api.sendMessage(update.message.chat.id, `Your Telegram user id is ${senderId}.\nPut TELEGRAM_OWNER_ID=${senderId} in Jarvis's .env and restart it.`);
    }
    return;
  }

  // Locked to the owner, in a private chat with the bot. Everything else is ignored, silently.
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  if (senderId !== ownerId || chatId !== ownerId || (update.message && update.message.chat.type !== "private")) {
    bumpState(db, "ignored_updates", now);
    return;
  }
  if (!deps.limiter.allow()) {
    bumpState(db, "rate_limited_updates", now);
    return;
  }
  setState(db, "last_received_at", now.toISOString(), now);

  // Buttons are not used any more (some chat apps do not show them): taps on old ones are ignored.
  if (update.callback_query) {
    await quietly(() => api.answerCallbackQuery(update.callback_query!.id, `Please reply with a number instead.`), log);
    return;
  }

  const message = update.message;
  if (!message) return;
  const text = (message.text ?? "").trim();
  if (!text) return; // photos, stickers and so on: nothing to do

  if (text.length > MAX_INCOMING_CHARS) {
    notify(`That message is too long (the limit is ${MAX_INCOMING_CHARS} characters). Nothing was saved.`);
    return;
  }

  if (text.startsWith("/")) {
    const word = COMMAND_WORD.exec(text)?.[0].toLowerCase() ?? "";
    if (word === "/log") {
      notify(await logCommand(deps, text.slice(word.length).trim(), now));
      return;
    }
    if (word === "/recat") {
      // /recat <expense id> <number>: the ONLY command that changes anything, and only a category.
      const m = /^\/recat\s+#?(\d{1,9})\s+(\d)$/i.exec(text);
      const label = m ? recategorise(db, Number(m[1]), Number(m[2]), now) : null;
      if (label) {
        notify(`#${m![1]} is now ${label}.`);
        deps.onLabelled?.();
      } else {
        notify(`Use /recat <id> <number>, for example /recat 12 3. Numbers: ${CATEGORIES.map((c, i) => `${i + 1} ${c.label}`).join(", ")}.`);
      }
      return;
    }
    notify(runCommand(db, word, now));
    return;
  }

  // Plain text only means something as the answer to one of my questions (a reply to it).
  const expenseId = message.reply_to_message ? findExpenseByQuestionMessage(db, message.reply_to_message.message_id) : undefined;
  if (expenseId === undefined) {
    notify("I only understand replies to my questions, and a few commands. Try /help.");
    return;
  }
  const reply = applyReply(db, expenseId, text, now);
  switch (reply.result) {
    case "category":
      notify(`Saved: ${reply.category}`);
      deps.onLabelled?.();
      break;
    case "skipped":
      notify("Skipped. I won't ask about it again.");
      break;
    case "purpose":
      notify(`Saved note: ${reply.purpose}`);
      deps.onLabelled?.();
      break;
    case "bad_number":
      notify(`Pick a number from 1 to ${SKIP_NUMBER}, or type anything else for Other.`);
      break;
    case "already":
      notify("That expense is already done.");
      break;
    case "not_found":
      notify("I can't find that expense.");
      break;
  }
}

/** /log <words>: read the words with the AI, check them in code, save one expense. Returns the reply. */
async function logCommand(deps: BotDeps, words: string, now: Date): Promise<string> {
  if (!words) return LOG_USAGE;
  if (!deps.llm) return "AI isn't set up (AI_GATEWAY_API_KEY), so I can't read that. Nothing was saved.";
  try {
    const verdict = await parseLog(deps.llm, words, now);
    if (!verdict.ok) return `${verdict.reason} Nothing was saved.

${LOG_USAGE}`;
    const e = verdict.expense;
    const saved = insertManualExpense(deps.db, e, words, now);
    const what = `#${saved.id}: ${money(e.amount_cents, e.currency)} at ${e.merchant}, ${formatWhen(e.occurred_at, now)}`;
    if (saved.repeatOf) return `That looks like ${what}, which is already logged. Nothing new was saved.`;
    deps.onLogged?.();
    return `Logged ${what}${e.timeDefaulted ? " (no time given, so I used the default)" : ""}.`;
  } catch (err) {
    if (err instanceof AiCapError) return `AI is paused (${err.message}), so I can't read that. Nothing was saved. Try again later.`;
    if (err instanceof LlmJsonError) return `I couldn't understand that. Nothing was saved.\n\n${LOG_USAGE}`;
    if (err instanceof LlmError) return "I couldn't reach the AI just now. Nothing was saved. Try again in a minute.";
    throw err;
  }
}

async function quietly(fn: () => Promise<unknown>, log: (m: string) => void): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log(`telegram call failed: ${(err as Error).message}`);
  }
}

/**
 * Long polling: ask Telegram for new updates, handle them, remember how far we got. Nothing is
 * exposed through the tunnel. Runs inside the main service until the returned function is called.
 */
export function startPolling(deps: {
  db: Database.Database;
  api: TelegramApi;
  handle: (raw: unknown) => Promise<void>;
  log: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): () => void {
  const { db, api, handle, log } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let stopped = false;

  void (async () => {
    let failures = 0;
    while (!stopped) {
      try {
        if (getState(db, "bot_username") === null) {
          const me = await api.getMe();
          setState(db, "bot_username", me.username ?? String(me.id));
        }
        const updates = await api.getUpdates(Number(getState(db, "offset") ?? 0), POLL_TIMEOUT_SECONDS);
        setState(db, "last_poll_ok_at", new Date().toISOString());
        setState(db, "last_poll_error", null);
        failures = 0;
        for (const raw of updates) {
          try {
            await handle(raw);
          } catch (err) {
            log(`update failed: ${(err as Error).message}`);
          }
          const id = (raw as { update_id?: unknown }).update_id;
          if (typeof id === "number") setState(db, "offset", id + 1);
        }
      } catch (err) {
        failures++;
        const message = err instanceof Error ? err.message : String(err);
        setState(db, "last_poll_error", message.slice(0, 300));
        if (failures === 1 || failures % 10 === 0) log(`polling failed (${failures}): ${message}`);
        // 409 = another copy of the bot is polling (often the old process, for a few seconds).
        await sleep(/HTTP 409/.test(message) ? 5000 : Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)));
      }
    }
  })();

  return () => {
    stopped = true;
  };
}
