import type Database from "better-sqlite3";
import { addColumnIfMissing } from "../sqlite";

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
      last_attempt_at TEXT,
      -- Where it came from: 'tap' (Wallet webhook) or 'email' (Gmail invoice).
      source          TEXT NOT NULL DEFAULT 'tap',
      -- The email that (also) describes this purchase. Unique, so one email is one expense.
      email_message_id TEXT,
      -- 'receipt' (a payment was made) or 'invoice' (a bill). Used to pair an invoice with its receipt.
      email_kind      TEXT,
      -- Set when a tap and an email were recognised as the same purchase and merged into this row.
      merged_at       TEXT,
      -- The merchant text last written to the Sheet (so a better name can be pushed later).
      merchant_synced TEXT,
      -- Telegram questions. asked_at is set when the question is queued, so an expense is asked
      -- about once, ever. answered_at is set by a button (including Skip) or a text reply.
      category        TEXT,
      purpose         TEXT,
      asked_at        TEXT,
      answered_at     TEXT,
      question_message_id INTEGER,
      -- What was last written to the Sheet (so changes are pushed to the existing row).
      category_synced TEXT,
      purpose_synced  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses (sheet_status, id);
    CREATE INDEX IF NOT EXISTS idx_expenses_received ON expenses (received_at);
  `);

  // Databases made before emails existed get the new columns here.
  addColumnIfMissing(db, "expenses", "source", "TEXT NOT NULL DEFAULT 'tap'");
  addColumnIfMissing(db, "expenses", "email_message_id", "TEXT");
  addColumnIfMissing(db, "expenses", "email_kind", "TEXT");
  addColumnIfMissing(db, "expenses", "merged_at", "TEXT");
  addColumnIfMissing(db, "expenses", "merchant_synced", "TEXT");
  for (const col of ["category", "purpose", "asked_at", "answered_at", "category_synced", "purpose_synced"]) {
    addColumnIfMissing(db, "expenses", col, "TEXT");
  }
  addColumnIfMissing(db, "expenses", "question_message_id", "INTEGER");
  // Who chose the category: 'owner' (you), 'ai', or 'history' (same merchant as the last few times).
  addColumnIfMissing(db, "expenses", "category_source", "TEXT");
  // How many times the AI call for this expense failed (after 3 we ask you instead).
  addColumnIfMissing(db, "expenses", "categorise_attempts", "INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    UPDATE expenses SET merchant_synced = merchant WHERE sheet_status = 'synced' AND merchant_synced IS NULL;
    -- Categories chosen before the AI existed were all chosen by the owner. "Food" is now "Food and drinks".
    UPDATE expenses SET category_source = 'owner' WHERE category IS NOT NULL AND category_source IS NULL;
    UPDATE expenses SET category = 'Food and drinks' WHERE category = 'Food';
    CREATE INDEX IF NOT EXISTS idx_expenses_question ON expenses (question_message_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_email ON expenses (email_message_id) WHERE email_message_id IS NOT NULL;
  `);
}
