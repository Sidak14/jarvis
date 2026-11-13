import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config";
import { createAllTables } from "./schema";

fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });

export const db = new Database(config.DB_PATH);
fs.chmodSync(config.DB_PATH, 0o600); // the database holds Spotify/Gmail tokens: owner only
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

createAllTables(db);

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
