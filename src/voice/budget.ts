import type Database from "better-sqlite3";
import { monthKey, monthRange } from "../telegram/time";

// The voice budget: US$ per Sydney month (VOICE_MONTHLY_CAP_USD). Cost comes from Vapi's end-of-call report. It counts what
// Vapi reports; Twilio's own per-minute and number charges are billed by Twilio and are not in it.
//   80%  one Telegram message, once a month
//   100% no new outbound calls, and the tools answer "the monthly voice limit has been reached"

export const VOICE_PROVIDER = "vapi"; // the api_usage row (the AI spend cap uses provider "ai_gateway": the two never mix)
export const WARN_FRACTION = 0.8;

export type BudgetLevel = "ok" | "warn" | "capped";
export interface Budget {
  spent: number;
  cap: number;
  fraction: number;
  level: BudgetLevel;
}

export function monthSpend(db: Database.Database, now: Date): number {
  const { start, end } = monthRange(monthKey(now));
  return db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) FROM voice_calls WHERE started_at >= ? AND started_at < ?`).pluck().get(start.toISOString(), end.toISOString()) as number;
}

export function budget(db: Database.Database, now: Date, cap: number): Budget {
  const spent = monthSpend(db, now);
  const fraction = cap > 0 ? spent / cap : 1;
  return { spent, cap, fraction, level: fraction >= 1 ? "capped" : fraction >= WARN_FRACTION ? "warn" : "ok" };
}

/** Add a finished call's cost to api_usage (so it shows with the other API spend). */
export function recordUsage(db: Database.Database, cost: number, now: Date): void {
  db.prepare(
    `INSERT INTO api_usage (provider, date, units_used, limit_units, input_tokens, output_tokens, cost_usd)
     VALUES (?, ?, 1, 0, 0, 0, ?)
     ON CONFLICT(provider, date) DO UPDATE SET units_used = units_used + 1, cost_usd = cost_usd + excluded.cost_usd`,
  ).run(VOICE_PROVIDER, now.toISOString().slice(0, 10), cost);
}

export function getFlag(db: Database.Database, key: string): string | null {
  return (db.prepare(`SELECT value FROM voice_state WHERE key = ?`).pluck().get(key) as string | undefined) ?? null;
}
export function setFlag(db: Database.Database, key: string, value: string): void {
  db.prepare(`INSERT INTO voice_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/**
 * After a call's cost is known: say once per month when the 80% line is crossed, and once when the cap is reached.
 * Returns the message to send (or null).
 */
export function budgetAlert(db: Database.Database, now: Date, cap: number): string | null {
  const b = budget(db, now, cap);
  const month = monthKey(now);
  const money = (n: number) => `$${n.toFixed(2)}`;
  if (b.level === "capped" && getFlag(db, "capped_month") !== month) {
    setFlag(db, "capped_month", month);
    setFlag(db, "warned_month", month);
    return `🛑 The monthly voice limit is reached (${money(b.spent)} of ${money(b.cap)}). Jarvis won't phone you, and phone tools are off, until next month.`;
  }
  if (b.level === "warn" && getFlag(db, "warned_month") !== month) {
    setFlag(db, "warned_month", month);
    return `⚠️ Voice spend is at ${Math.round(b.fraction * 100)}% of the monthly limit (${money(b.spent)} of ${money(b.cap)}).`;
  }
  return null;
}
