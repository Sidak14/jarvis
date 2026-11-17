import type Database from "better-sqlite3";

export function createLocationTables(db: Database.Database): void {
  db.exec(`
    -- Where I am now: one row. place is 'Home' | 'Work' | 'Gym' | 'Other'.
    CREATE TABLE IF NOT EXISTS location_now (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      place      TEXT NOT NULL,
      since      TEXT NOT NULL
    );
    -- Every enter/leave the phone reported, as it came in.
    CREATE TABLE IF NOT EXISTS location_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      place       TEXT NOT NULL,
      event       TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
  `);
}
