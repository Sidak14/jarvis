import type Database from "better-sqlite3";

export function createGmailTables(db: Database.Database): void {
  db.exec(`
    -- Every email we have dealt with. message_id is the primary key, so an email is never
    -- processed twice. We keep no email text, only what we decided.
    --   invoice     = a payment receipt (detail says what happened to it)
    --   not_invoice = not a receipt (filtered by code, or the model said no)
    --   error       = could not be used (model gave bad output, failed sanity checks)
    -- dry_run = 1 marks an 'invoice' seen in dry-run mode: a preview, redone when going live.
    CREATE TABLE IF NOT EXISTS processed_emails (
      message_id   TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL,
      result       TEXT NOT NULL CHECK (result IN ('invoice', 'not_invoice', 'error')),
      detail       TEXT,
      dry_run      INTEGER NOT NULL DEFAULT 0,
      expense_id   INTEGER
    );

    -- The one Gmail login. Exactly one row (id is always 1).
    CREATE TABLE IF NOT EXISTS gmail_auth (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      access_token  TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at    INTEGER NOT NULL,
      scope         TEXT,
      updated_at    TEXT NOT NULL
    );

    -- Summary of the latest run, for the status page. One row.
    CREATE TABLE IF NOT EXISTS gmail_state (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      last_run_at TEXT NOT NULL,
      last_status TEXT NOT NULL,
      dry_run     INTEGER NOT NULL,
      checked     INTEGER NOT NULL,
      invoices    INTEGER NOT NULL,
      merges      INTEGER NOT NULL,
      added       INTEGER NOT NULL,
      errors      INTEGER NOT NULL,
      last_error  TEXT,
      ai_blocked  TEXT
    );
  `);
}
