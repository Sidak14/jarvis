import type Database from "better-sqlite3";

export function createPlansTables(db: Database.Database): void {
  db.exec(`
    -- Small facts: started_at, last poll, last error, last batch...
    CREATE TABLE IF NOT EXISTS plans_state (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TEXT NOT NULL
    );

    -- Messages (and reactions) read from Beeper. Text is kept ONLY until the batch is processed,
    -- then it is erased and just the id stays, so nothing is ever processed twice.
    --   pending   = waiting to be sent to the model
    --   processed = done (text erased)
    --   skipped   = not sent (prefilter said no, or the model failed too often); text erased
    --   baseline  = older than the first start: remembered, never processed
    -- kind 'reaction': text is a short snippet of the message reacted to, reaction_key the emoji,
    -- target_id the message it was on.
    CREATE TABLE IF NOT EXISTS plan_messages (
      chat_id      TEXT NOT NULL,
      id           TEXT NOT NULL,
      kind         TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'reaction')),
      sender_id    TEXT,
      sender_name  TEXT,
      is_me        INTEGER NOT NULL DEFAULT 0,
      ts           TEXT NOT NULL,
      text         TEXT,
      reaction_key TEXT,
      target_id    TEXT,
      status       TEXT NOT NULL CHECK (status IN ('pending', 'processed', 'skipped', 'baseline')),
      attempts     INTEGER NOT NULL DEFAULT 0,
      seen_at      TEXT NOT NULL,
      processed_at TEXT,
      PRIMARY KEY (chat_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_plan_messages_pending ON plan_messages (status, chat_id, ts);

    -- Reactions already noticed (message, who, which emoji), so a reaction counts once.
    CREATE TABLE IF NOT EXISTS plan_reactions_seen (
      chat_id        TEXT NOT NULL,
      message_id     TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      reaction_key   TEXT NOT NULL,
      PRIMARY KEY (chat_id, message_id, participant_id, reaction_key)
    );

    -- Per-chat bookkeeping for the status page.
    CREATE TABLE IF NOT EXISTS plan_chat_state (
      chat_id         TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      type            TEXT NOT NULL,
      why             TEXT NOT NULL,
      last_polled_at  TEXT,
      last_batch_at   TEXT
    );

    -- Who is in which chat (ids only). Used for "is this sender in the plan's chat?" and the DM rule.
    CREATE TABLE IF NOT EXISTS plan_members (
      chat_id    TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      is_self    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, user_id)
    );

    -- The plans. plans.md is written from this table (never by the model).
    CREATE TABLE IF NOT EXISTS plans (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT NOT NULL,
      what            TEXT,
      date            TEXT,
      start_time      TEXT,
      end_time        TEXT,
      location        TEXT,
      meeting_point   TEXT,
      participants    TEXT NOT NULL DEFAULT '[]',
      cost            TEXT,
      bring           TEXT,
      url             TEXT,
      notes           TEXT NOT NULL DEFAULT '[]',
      plan_status     TEXT NOT NULL CHECK (plan_status IN ('proposed', 'confirmed', 'cancelled')),
      my_stance       TEXT NOT NULL DEFAULT 'none' CHECK (my_stance IN ('none', 'committed', 'declined', 'unsure')),
      date_certainty  TEXT NOT NULL DEFAULT 'exact' CHECK (date_certainty IN ('exact', 'ambiguous')),
      confidence      REAL NOT NULL DEFAULT 0,
      source_chat_id  TEXT NOT NULL,
      source_chat_name TEXT NOT NULL,
      linked_chats    TEXT NOT NULL DEFAULT '[]',
      possible_link   TEXT,
      source_message_ids TEXT NOT NULL DEFAULT '[]',
      history         TEXT NOT NULL DEFAULT '[]',
      raised_at       TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      last_updated    TEXT NOT NULL,
      replied_at      TEXT,
      -- Calendar. cal_state: none | created | clash | suppressed | removed
      event_id        TEXT,
      event_link      TEXT,
      event_version   TEXT,
      cal_state       TEXT NOT NULL DEFAULT 'none',
      cal_state_version TEXT,
      last_pinged_at  TEXT,
      archived_at     TEXT
    );

    -- My stance over time. The current stance is the latest explicit one BY MESSAGE TIME.
    CREATE TABLE IF NOT EXISTS plan_stances (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id    INTEGER NOT NULL,
      stance     TEXT NOT NULL CHECK (stance IN ('committed', 'declined', 'unsure')),
      message_id TEXT NOT NULL,
      chat_id    TEXT NOT NULL,
      ts         TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (plan_id, message_id)
    );

    -- Everything Jarvis did (or, in dry run, WOULD do) for a plan. UNIQUE(plan_id, kind, key)
    -- is what makes actions idempotent: the same action for the same plan version happens once.
    CREATE TABLE IF NOT EXISTS plan_actions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id    INTEGER NOT NULL,
      kind       TEXT NOT NULL,
      key        TEXT NOT NULL,
      dry_run    INTEGER NOT NULL DEFAULT 0,
      detail     TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (plan_id, kind, key)
    );

    -- The Google Calendar login (calendar.events + calendar.readonly). One row.
    CREATE TABLE IF NOT EXISTS calendar_auth (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      access_token  TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at    INTEGER NOT NULL,
      scope         TEXT,
      updated_at    TEXT NOT NULL
    );
  `);
}
