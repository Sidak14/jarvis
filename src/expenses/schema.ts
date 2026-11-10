import type Database from "better-sqlite3";

export function createExpenseTables(db: Database.Database): void {
  db.exec(`
    -- Every expense that reaches the webhook is stored here first, before Google is involved.
    -- sheet_status: pending   = waiting to be written to the Sheet (retried every 15 minutes)
    --               syncing   = a write started (if we crash here, the next run checks the Sheet first)
    --               synced    = written to the Sheet (sheet_row says where)
    --               duplicate = the same tap fired twice; ignored, duplicate_of says which row it copies
    --               unparsed  = we could not read merchant/amount from raw_data; kept so nothing is lost
    CREATE TABLE IF NOT EXISTS expenses (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant        TEXT,
      amount_cents    INTEGER,
      currency        TEXT NOT NULL DEFAULT 'AUD',
      card            TEXT,
      occurred_at     TEXT,
      received_at     TEXT NOT NULL,
      sheet_status    TEXT NOT NULL CHECK (sheet_status IN ('pending','syncing','synced','duplicate','unparsed')),
      sheet_row       INTEGER,
      raw_payload     TEXT NOT NULL,
      parse_status    TEXT NOT NULL CHECK (parse_status IN ('ok','unparsed')),
      duplicate_of    INTEGER,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      last_attempt_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses (sheet_status, id);
    CREATE INDEX IF NOT EXISTS idx_expenses_received ON expenses (received_at);
  `);
}
