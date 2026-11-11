import type Database from "better-sqlite3";
import { addColumnIfMissing } from "../sqlite";

export function createTelegramTables(db: Database.Database): void {
  db.exec(`
    -- Every message Jarvis wants to send. notify() writes the row FIRST, then tries to send it.
    -- A failed send stays 'pending' and is retried with backoff, so nothing is lost.
    --   pending = not sent yet (next_attempt_at says when we try again)
    --   sent    = Telegram accepted it
    --   failed  = gave up after too many attempts (shown on the status page)
    -- kind + ref say what the message is about (e.g. kind 'expense_question', ref '12'), so
    -- once Telegram gives us the message id we can attach it to the right expense.
    CREATE TABLE IF NOT EXISTS outbox (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      text                TEXT NOT NULL,
      options             TEXT,
      status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
      attempts            INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL,
      sent_at             TEXT,
      error               TEXT,
      next_attempt_at     TEXT NOT NULL,
      -- Not sent before this moment (messages that can wait are held until 9am).
      send_after          TEXT,
      kind                TEXT,
      ref                 TEXT,
      telegram_message_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox (status, next_attempt_at);

    -- Small facts about the bot: the getUpdates offset, last message in/out, connection state...
    CREATE TABLE IF NOT EXISTS telegram_state (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TEXT NOT NULL
    );

    -- Alert cooldowns: an alert with the same key is not sent again until its cooldown is over.
    CREATE TABLE IF NOT EXISTS alert_state (
      key         TEXT PRIMARY KEY,
      last_sent_at TEXT NOT NULL,
      suppressed  INTEGER NOT NULL DEFAULT 0
    );

    -- Monthly recaps already handled. The month is the primary key, so one month is never sent twice.
    CREATE TABLE IF NOT EXISTS monthly_recaps (
      month      TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      outbox_id  INTEGER
    );

    -- Logins/consents with a known end date (checked daily: alert if one ends within 14 days).
    CREATE TABLE IF NOT EXISTS consents (
      name       TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    );
  `);
  addColumnIfMissing(db, "outbox", "send_after", "TEXT");
}
