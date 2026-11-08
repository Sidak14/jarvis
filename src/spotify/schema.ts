import type Database from "better-sqlite3";

export function createSpotifyTables(db: Database.Database): void {
  db.exec(`
    -- Every play we have ever seen. (track_id, played_at) is the primary key,
    -- so polling the same window twice can never double-count a play.
    CREATE TABLE IF NOT EXISTS play_history (
      track_id   TEXT NOT NULL,
      played_at  TEXT NOT NULL,
      track_name TEXT NOT NULL,
      artists    TEXT NOT NULL,
      PRIMARY KEY (track_id, played_at)
    );
    CREATE INDEX IF NOT EXISTS idx_play_history_played ON play_history (played_at DESC);

    -- Tracks we have dealt with. A track is only ever liked once.
    -- source: 'jarvis' = we liked it, 'existing' = it was already liked.
    -- If you un-like a track later, it stays here, so Jarvis will not like it again.
    CREATE TABLE IF NOT EXISTS likes (
      track_id   TEXT PRIMARY KEY,
      track_name TEXT NOT NULL,
      liked_at   TEXT NOT NULL,
      source     TEXT NOT NULL CHECK (source IN ('jarvis', 'existing'))
    );

    -- What Spotify last told us about each track (liked or not), for the dashboard.
    CREATE TABLE IF NOT EXISTS track_status (
      track_id   TEXT PRIMARY KEY,
      is_liked   INTEGER NOT NULL,
      checked_at TEXT NOT NULL
    );

    -- The one Spotify login. Exactly one row (id is always 1).
    CREATE TABLE IF NOT EXISTS spotify_auth (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      access_token  TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at    INTEGER NOT NULL,
      scope         TEXT,
      updated_at    TEXT NOT NULL
    );
  `);
}
