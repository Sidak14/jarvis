import type Database from "better-sqlite3";
import { createExpenseTables } from "./expenses/schema";
import { createGmailTables } from "./gmail/schema";
import { createPlansTables } from "./plans/schema";
import { createSpotifyTables } from "./spotify/schema";
import { addColumnIfMissing } from "./sqlite";
import { createTelegramTables } from "./telegram/schema";

/** Every table in the database. db.ts runs this on startup; the tests run it on an in-memory database. */
export function createAllTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      name        TEXT PRIMARY KEY,
      schedule    TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT
    );

    CREATE TABLE IF NOT EXISTS runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      job         TEXT NOT NULL,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      status      TEXT NOT NULL CHECK (status IN ('running', 'success', 'failure')),
      duration_ms INTEGER,
      log         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_job ON runs (job, started_at DESC);

    CREATE TABLE IF NOT EXISTS api_usage (
      provider    TEXT NOT NULL,
      date        TEXT NOT NULL,
      units_used  INTEGER NOT NULL DEFAULT 0,
      limit_units INTEGER,
      PRIMARY KEY (provider, date)
    );
  `);

  // How many runs of a job failed in a row (alerts read this).
  addColumnIfMissing(db, "jobs", "consecutive_failures", "INTEGER NOT NULL DEFAULT 0");

  // LLM calls also record tokens and estimated cost in api_usage.
  addColumnIfMissing(db, "api_usage", "input_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "api_usage", "output_tokens", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "api_usage", "cost_usd", "REAL NOT NULL DEFAULT 0");

  // The same calls broken down by which feature made them (invoices, plans, categorising, /log). Display only:
  // the caps still read the combined api_usage totals above.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage_by_feature (
      feature       TEXT NOT NULL,
      date          TEXT NOT NULL,
      calls         INTEGER NOT NULL DEFAULT 0,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (feature, date)
    );
  `);

  createSpotifyTables(db);
  createExpenseTables(db);
  createGmailTables(db);
  createTelegramTables(db);
  createPlansTables(db);


}
