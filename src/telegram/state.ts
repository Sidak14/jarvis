import type Database from "better-sqlite3";

// Tiny key/value store for facts about the bot (offset, last message, connection state).

export function setState(db: Database.Database, key: string, value: string | number | null, now = new Date()): void {
  db.prepare(
    `INSERT INTO telegram_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value === null ? null : String(value), now.toISOString());
}

export function getState(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM telegram_state WHERE key = ?`).get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function bumpState(db: Database.Database, key: string, now = new Date()): void {
  setState(db, key, Number(getState(db, key) ?? 0) + 1, now);
}
