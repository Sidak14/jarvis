import type Database from "better-sqlite3";

const today = () => new Date().toISOString().slice(0, 10); // UTC date

/** Count one Spotify Web API call in the api_usage table. */
export function recordApiCall(db: Database.Database): void {
  db.prepare(
    `INSERT INTO api_usage (provider, date, units_used) VALUES ('spotify', ?, 1)
     ON CONFLICT(provider, date) DO UPDATE SET units_used = units_used + 1`,
  ).run(today());
}

export function apiCallsToday(db: Database.Database): number {
  const row = db
    .prepare(`SELECT units_used FROM api_usage WHERE provider = 'spotify' AND date = ?`)
    .get(today()) as { units_used: number } | undefined;
  return row?.units_used ?? 0;
}
