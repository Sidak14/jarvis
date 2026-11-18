import type Database from "better-sqlite3";

export function createSettingsTables(db: Database.Database): void {
  db.exec(`
    -- Values I changed on the dashboard. A setting with no row here uses its default (see defs.ts).
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}
