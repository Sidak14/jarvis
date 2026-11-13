import type Database from "better-sqlite3";
import { ago, money, oneLine } from "./format";
import { CATEGORIES } from "./settings";
import { monthKey, monthRange, formatWhen } from "./time";

// The only commands. Each one is plain code that reads the database and returns text.
// Message text never reaches a shell, eval or anything else that could run it.

export const HELP = `Jarvis commands
/status - jobs, last runs, sheet sync
/spend - this month so far
/unlabeled - expenses with no category or purpose
/log <day> <amount> <where> - add an expense by hand, e.g. /log yesterday 45 at Star Casino
/recent - your last 10 expenses and their categories
/recat <id> <number> - change a category (numbers are in /recent)
/plans - plans found in your chats (more: /undo /addback /addanyway /keep /remove, with a plan code like P-0001)
/help - this list

I categorise expenses myself. When I'm not sure I ask: reply to my question with a number. Anything else you type is saved as Other.`;

interface JobRow {
  name: string;
  last_run_at: string | null;
  consecutive_failures: number;
}

export function statusText(db: Database.Database, now: Date): string {
  const jobs = db.prepare(`SELECT name, last_run_at, consecutive_failures FROM jobs ORDER BY name`).all() as JobRow[];
  const lines = jobs.map((j) => {
    const state = j.consecutive_failures > 0 ? `FAILING x${j.consecutive_failures}` : "ok";
    return `${j.name}: ${state}, ${ago(j.last_run_at, now)}`;
  });
  const sheet = db
    .prepare(`SELECT COUNT(*) AS n, MIN(received_at) AS oldest FROM expenses WHERE sheet_status IN ('pending','syncing')`)
    .get() as { n: number; oldest: string | null };
  const outbox = db
    .prepare(`SELECT SUM(status = 'pending') AS pending, SUM(status = 'failed') AS failed FROM outbox`)
    .get() as { pending: number | null; failed: number | null };
  return [
    "Jarvis status",
    ...lines,
    "",
    sheet.n ? `Sheet: ${sheet.n} pending (oldest ${ago(sheet.oldest, now)})` : "Sheet: all synced",
    `Messages: ${outbox.pending ?? 0} waiting, ${outbox.failed ?? 0} failed`,
  ].join("\n");
}

/** Spend per category this Sydney month so far (AUD). */
export function spendText(db: Database.Database, now: Date): string {
  const { start, end } = monthRange(monthKey(now));
  const where = `sheet_status NOT IN ('duplicate','unparsed') AND amount_cents IS NOT NULL AND occurred_at >= ? AND occurred_at < ?`;
  const total = db
    .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS n FROM expenses WHERE currency = 'AUD' AND ${where}`)
    .get(start.toISOString(), end.toISOString()) as { cents: number; n: number };
  const cats = db
    .prepare(
      `SELECT COALESCE(category, 'Uncategorised') AS name, SUM(amount_cents) AS cents FROM expenses
        WHERE currency = 'AUD' AND ${where} GROUP BY name ORDER BY cents DESC LIMIT 6`,
    )
    .all(start.toISOString(), end.toISOString()) as { name: string; cents: number }[];
  const other = db
    .prepare(`SELECT COUNT(*) AS n FROM expenses WHERE currency != 'AUD' AND ${where}`)
    .get(start.toISOString(), end.toISOString()) as { n: number };
  if (total.n === 0 && other.n === 0) return "Nothing spent this month yet.";
  return [
    `This month so far: ${money(total.cents, "AUD")} (${total.n} expense${total.n === 1 ? "" : "s"})`,
    ...cats.map((c) => `${c.name}: ${money(c.cents, "AUD")}`),
    ...(other.n ? [`+ ${other.n} in other currencies`] : []),
  ].join("\n");
}

export function unlabeledText(db: Database.Database, now: Date): string {
  const rows = db
    .prepare(
      `SELECT id, merchant, amount_cents, currency, occurred_at FROM expenses
        WHERE category IS NULL AND purpose IS NULL AND parse_status = 'ok'
          AND sheet_status NOT IN ('duplicate','unparsed') AND amount_cents IS NOT NULL
        ORDER BY occurred_at DESC`,
    )
    .all() as { id: number; merchant: string; amount_cents: number; currency: string; occurred_at: string }[];
  if (rows.length === 0) return "Every expense has a label.";
  const shown = rows.slice(0, 15).map((r) => `#${r.id} ${money(r.amount_cents, r.currency)} ${oneLine(r.merchant, 30)}, ${formatWhen(new Date(r.occurred_at), now)}`);
  return [`${rows.length} unlabeled:`, ...shown, ...(rows.length > 15 ? [`...and ${rows.length - 15} more`] : [])].join("\n");
}

const SOURCE_NAMES: Record<string, string> = { ai: "AI", history: "same merchant", owner: "you" };

/** The last 10 expenses with their category and who chose it (plain text, no buttons). */
export function recentText(db: Database.Database, now: Date): string {
  const rows = db
    .prepare(
      `SELECT id, merchant, amount_cents, currency, occurred_at, category, category_source FROM expenses
        WHERE parse_status = 'ok' AND sheet_status NOT IN ('duplicate','unparsed')
          AND amount_cents IS NOT NULL AND occurred_at IS NOT NULL
        ORDER BY occurred_at DESC, id DESC LIMIT 10`,
    )
    .all() as { id: number; merchant: string; amount_cents: number; currency: string; occurred_at: string; category: string | null; category_source: string | null }[];
  if (rows.length === 0) return "No expenses yet.";
  return [
    ...rows.map(
      (r) =>
        `#${r.id} ${money(r.amount_cents, r.currency)} ${oneLine(r.merchant, 30)}, ${formatWhen(new Date(r.occurred_at), now)}\n   ${r.category ? `${r.category} (${SOURCE_NAMES[r.category_source ?? ""] ?? "you"})` : "not categorised"}`,
    ),
    "",
    `To change one: /recat <id> <number>, e.g. /recat ${rows[0].id} 3`,
    CATEGORIES.map((c, i) => `${i + 1} ${c.label}`).join(", "),
  ].join("\n");
}

/** Run one command word (like "/status"). Unknown commands get a pointer to /help. */
export function runCommand(db: Database.Database, command: string, now = new Date()): string {
  switch (command) {
    case "/start":
      return "Jarvis is online. /help lists what I can do.";
    case "/help":
      return HELP;
    case "/status":
      return statusText(db, now);
    case "/spend":
      return spendText(db, now);
    case "/unlabeled":
      return unlabeledText(db, now);
    case "/recent":
      return recentText(db, now);
    default:
      return "I don't know that command. /help lists them.";
  }
}
