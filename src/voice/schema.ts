import type Database from "better-sqlite3";

export function createVoiceTables(db: Database.Database): void {
  db.exec(`
    -- One row per phone call (either direction). Only a SUMMARY is kept: no transcript, no recording.
    CREATE TABLE IF NOT EXISTS voice_calls (
      call_id          TEXT PRIMARY KEY,
      direction        TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      started_at       TEXT NOT NULL,
      ended_at         TEXT,
      duration_s       INTEGER,
      cost_usd         REAL,
      ended_reason     TEXT,
      summary          TEXT,
      caller           TEXT,
      alert_episode_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_voice_calls_started ON voice_calls (started_at);

    -- Every tool the model ran. Arguments are NOT stored (they could hold a PIN); only their names.
    CREATE TABLE IF NOT EXISTS voice_tool_calls (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id     TEXT NOT NULL,
      tool        TEXT NOT NULL,
      status      TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      ts          TEXT NOT NULL,
      arg_names   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_voice_tool_calls_call ON voice_tool_calls (call_id);
  `);
}
