import type Database from "better-sqlite3";

// Event photos -> OneDrive tables. Nothing here holds message text: only ids, times and counts.

export function createPhotosTables(db: Database.Database): void {
  db.exec(`
    -- Small facts: the confirmed Uni Events folder id, bytes uploaded today, last quota check, alert flags...
    CREATE TABLE IF NOT EXISTS photo_state (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TEXT NOT NULL
    );

    -- The Microsoft login (Files.ReadWrite + offline_access). One row.
    CREATE TABLE IF NOT EXISTS onedrive_auth (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      access_token  TEXT,
      refresh_token TEXT,
      expires_at    INTEGER,
      scope         TEXT,
      refreshed_at  TEXT,
      needs_login   INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT,
      updated_at    TEXT NOT NULL
    );

    -- chat id -> the folder name it was given the first time, so a later chat rename never makes a second folder.
    CREATE TABLE IF NOT EXISTS photo_chat_folders (
      chat_id        TEXT PRIMARY KEY,
      folder_name    TEXT NOT NULL,
      folder_item_id TEXT,
      first_seen_at  TEXT NOT NULL
    );

    -- One row per plan that has photos to save. The event folder name is fixed when the row is made:
    -- a plan title that changes later never renames or splits a folder.
    CREATE TABLE IF NOT EXISTS photo_plans (
      plan_id        INTEGER PRIMARY KEY,
      chat_id        TEXT NOT NULL,
      chat_folder    TEXT NOT NULL,
      event_folder   TEXT NOT NULL,
      folder_item_id TEXT,
      announced_at   TEXT,
      summary_sent_at TEXT,
      created_at     TEXT NOT NULL
    );

    -- Every photo/video seen in a chat that is being watched. Ids and times only.
    CREATE TABLE IF NOT EXISTS media_seen (
      chat_id       TEXT NOT NULL,
      message_id    TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      idx           INTEGER NOT NULL,
      sender_id     TEXT NOT NULL,
      ts            TEXT NOT NULL,
      kind          TEXT NOT NULL,
      mime          TEXT,
      file_size     INTEGER,
      seen_at       TEXT NOT NULL,
      PRIMARY KEY (message_id, attachment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_media_seen_chat_ts ON media_seen (chat_id, ts);

    -- What was (or is waiting to be) saved. PRIMARY KEY (message_id, attachment_id) is what makes a double upload
    -- impossible, across restarts and retries.
    CREATE TABLE IF NOT EXISTS media_saved (
      message_id       TEXT NOT NULL,
      attachment_id    TEXT NOT NULL,
      plan_id          INTEGER NOT NULL,
      chat_id          TEXT NOT NULL,
      kind             TEXT NOT NULL,
      ts               TEXT NOT NULL,
      file_base        TEXT NOT NULL,
      file_name        TEXT,
      onedrive_item_id TEXT,
      saved_at         TEXT,
      status           TEXT NOT NULL CHECK (status IN ('pending','saved','skipped','rejected','failed')),
      attempts         INTEGER NOT NULL DEFAULT 0,
      next_attempt_at  TEXT,
      error            TEXT,
      bytes            INTEGER,
      created_at       TEXT NOT NULL,
      PRIMARY KEY (message_id, attachment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_media_saved_plan ON media_saved (plan_id, status);

    -- What Jarvis did, or in dry run WOULD do. UNIQUE(plan_id, kind, key) keeps each line to once.
    CREATE TABLE IF NOT EXISTS photo_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id    INTEGER NOT NULL,
      kind       TEXT NOT NULL,
      key        TEXT NOT NULL,
      dry_run    INTEGER NOT NULL DEFAULT 0,
      detail     TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (plan_id, kind, key)
    );
  `);
}
