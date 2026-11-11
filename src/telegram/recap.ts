import type Database from "better-sqlite3";
import { money } from "./format";
import type { Outbox } from "./outbox";
import { RECAP_CATCHUP_DAYS } from "./settings";
import { monthKey, monthName, monthRange, previousMonthKey, zoned } from "./time";

// The monthly recap is plain SQL and arithmetic. No LLM.

export interface Recap {
  month: string;
  totalCents: number; // AUD
  count: number; // all currencies
  otherCurrencyCount: number;
  byCategory: { name: string; cents: number }[];
  topMerchants: { name: string; cents: number }[];
  previousTotalCents: number;
  unlabeled: number;
}

export function buildRecap(db: Database.Database, month: string): Recap {
  const range = (key: string) => {
    const r = monthRange(key);
    return [r.start.toISOString(), r.end.toISOString()] as const;
  };
  // Real expenses only: not ignored duplicates, not unreadable rows.
  const where = `sheet_status NOT IN ('duplicate','unparsed') AND amount_cents IS NOT NULL AND occurred_at >= ? AND occurred_at < ?`;
  const [from, to] = range(month);

  const aud = db
    .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM expenses WHERE currency = 'AUD' AND ${where}`)
    .get(from, to) as { cents: number };
  const counts = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(currency != 'AUD'), 0) AS other FROM expenses WHERE ${where}`)
    .get(from, to) as { n: number; other: number };
  const byCategory = db
    .prepare(
      `SELECT COALESCE(category, 'Uncategorised') AS name, SUM(amount_cents) AS cents FROM expenses
        WHERE currency = 'AUD' AND ${where} GROUP BY name ORDER BY cents DESC`,
    )
    .all(from, to) as { name: string; cents: number }[];
  const topMerchants = db
    .prepare(
      // (SQLite shows `merchant` from the row with the largest single amount, so a merchant spelt
      // two ways is listed once, under its usual spelling.)
      `SELECT merchant AS name, SUM(amount_cents) AS cents, MAX(amount_cents) FROM expenses
        WHERE currency = 'AUD' AND ${where} GROUP BY lower(trim(merchant)) ORDER BY cents DESC LIMIT 5`,
    )
    .all(from, to) as { name: string; cents: number }[];
  const unlabeled = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM expenses WHERE category IS NULL AND purpose IS NULL AND ${where}`)
      .get(from, to) as { n: number }
  ).n;
  const [pFrom, pTo] = range(previousMonthKey(month));
  const previous = db
    .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM expenses WHERE currency = 'AUD' AND ${where}`)
    .get(pFrom, pTo) as { cents: number };

  return {
    month,
    totalCents: aud.cents,
    count: counts.n,
    otherCurrencyCount: counts.other,
    byCategory,
    topMerchants: topMerchants.map((m) => ({ name: m.name.trim(), cents: m.cents })),
    previousTotalCents: previous.cents,
    unlabeled,
  };
}

/** Short, phone-sized text. */
export function formatRecap(r: Recap): string {
  const name = monthName(r.month);
  const prev = monthName(previousMonthKey(r.month));
  const diff = r.totalCents - r.previousTotalCents;
  const change =
    r.previousTotalCents === 0
      ? `No spending recorded in ${prev} to compare with.`
      : `vs ${prev}: ${diff >= 0 ? "+" : "-"}${money(Math.abs(diff), "AUD")} (${diff >= 0 ? "+" : "-"}${Math.abs(Math.round((diff / r.previousTotalCents) * 100))}%)`;
  return [
    `${name} recap`,
    `Spent ${money(r.totalCents, "AUD")} across ${r.count} expense${r.count === 1 ? "" : "s"}`,
    change,
    ...(r.otherCurrencyCount ? [`(${r.otherCurrencyCount} in other currencies, not in the total)`] : []),
    "",
    "By category",
    ...r.byCategory.map((c) => `${c.name} ${money(c.cents, "AUD")}`),
    "",
    "Top merchants",
    ...r.topMerchants.map((m, i) => `${i + 1}. ${m.name} ${money(m.cents, "AUD")}`),
    "",
    r.unlabeled ? `${r.unlabeled} still unlabeled (/unlabeled)` : "Everything is labeled.",
  ].join("\n");
}

/**
 * Send last month's recap if it is due and has not been sent. Runs daily at 9am Sydney, so it is
 * sent on the 1st, or (if the Mac was off) within the next few days. The month is the primary key
 * of monthly_recaps, so a month is never sent twice, however often this is called.
 */
export function sendRecapIfDue(deps: {
  db: Database.Database;
  notify: Outbox["notify"];
  now?: Date;
}): "sent" | "empty" | "already" | "not_due" {
  const { db } = deps;
  const now = deps.now ?? new Date();
  if (zoned(now).day > RECAP_CATCHUP_DAYS) return "not_due";

  const month = previousMonthKey(monthKey(now));
  return db.transaction((): "sent" | "empty" | "already" => {
    const claimed = db
      .prepare(`INSERT OR IGNORE INTO monthly_recaps (month, created_at) VALUES (?, ?)`)
      .run(month, now.toISOString());
    if (claimed.changes === 0) return "already";

    const recap = buildRecap(db, month);
    if (recap.count === 0) return "empty"; // nothing to report (e.g. before Jarvis tracked anything)
    const id = deps.notify(formatRecap(recap));
    db.prepare(`UPDATE monthly_recaps SET outbox_id = ? WHERE month = ?`).run(id, month);
    return "sent";
  })();
}
