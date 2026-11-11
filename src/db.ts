import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config";
import { addColumnIfMissing } from "./sqlite";
import { createTelegramTables } from "./telegram/schema";
import { createGmailTables } from "./gmail/schema";
import { createExpenseTables } from "./expenses/schema";
import { createSpotifyTables } from "./spotify/schema";

fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });

export const db = new Database(config.DB_PATH);
fs.chmodSync(config.DB_PATH, 0o600); // the database holds Spotify/Gmail tokens: owner only
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

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

createSpotifyTables(db);
createExpenseTables(db);
createGmailTables(db);
createTelegramTables(db);

// A run still marked 'running' at startup was cut off by a crash or restart.
db.prepare(
  `UPDATE runs
      SET status = 'failure',
          finished_at = ?,
          log = COALESCE(log, '') || char(10) || 'interrupted: process restarted'
    WHERE status = 'running'`,
).run(new Date().toISOString());

export function closeDb(): void {
  db.close();
}
