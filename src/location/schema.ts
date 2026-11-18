import type Database from "better-sqlite3";

export function createLocationTables(db: Database.Database): void {
  db.exec(`
    -- Where each person is now: one row per person ('me', 'mom'). place is 'Home' | 'Work' | 'Gym' | 'Other'.
    CREATE TABLE IF NOT EXISTS person_location (
      person     TEXT PRIMARY KEY,
      place      TEXT NOT NULL,
      since      TEXT NOT NULL
    );
    -- Every enter/leave a phone reported, as it came in.
    CREATE TABLE IF NOT EXISTS location_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      place       TEXT NOT NULL,
      event       TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
  `);
  // Older databases: events had no person (they were all mine), and my place lived in the one-row location_now.
  if (!(db.prepare(`PRAGMA table_info(location_events)`).all() as { name: string }[]).some((c) => c.name === "person")) {
    db.exec(`ALTER TABLE location_events ADD COLUMN person TEXT NOT NULL DEFAULT 'me'`);
  }
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'location_now'`).get()) {
    db.exec(`INSERT OR IGNORE INTO person_location (person, place, since) SELECT 'me', place, since FROM location_now; DROP TABLE location_now;`);
  }
}
