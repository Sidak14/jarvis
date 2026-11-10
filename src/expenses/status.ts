import type Database from "better-sqlite3";
import { config } from "../config";
import { esc } from "../html";

interface Latest {
  id: number;
  received_at: string;
  merchant: string | null;
  amount_cents: number | null;
  currency: string;
  card: string | null;
  sheet_status: string;
  attempts: number;
  source: string;
}

const STUCK_AFTER_MS = 60 * 60 * 1000;
const fmt = (iso: string) => new Date(iso).toLocaleString("en-AU", { hour12: false });

/** The "Expenses" block of the status page. Ugly on purpose, but a problem is hard to miss. */
export function expensesSection(db: Database.Database, now = Date.now()): string {
  const count = (where: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM expenses WHERE ${where}`).get() as { n: number }).n;
  const pending = count(`sheet_status IN ('pending','syncing')`);
  const unparsed = count(`sheet_status = 'unparsed'`);
  const oldest = db
    .prepare(`SELECT MIN(received_at) AS t FROM expenses WHERE sheet_status IN ('pending','syncing')`)
    .get() as { t: string | null };
  const err = db
    .prepare(
      `SELECT last_error, last_attempt_at FROM expenses
        WHERE last_error IS NOT NULL AND (sheet_status IN ('pending','syncing') OR merchant IS NOT merchant_synced)
        ORDER BY last_attempt_at DESC LIMIT 1`,
    )
    .get() as { last_error: string; last_attempt_at: string } | undefined;
  const latest = db
    .prepare(
      `SELECT id, received_at, merchant, amount_cents, currency, card, sheet_status, attempts, source
         FROM expenses ORDER BY id DESC LIMIT 20`,
    )
    .all() as Latest[];

  const configured = Boolean(config.GOOGLE_SHEET_ID && config.GOOGLE_SERVICE_ACCOUNT_FILE);
  const stuck = oldest.t !== null && now - Date.parse(oldest.t) > STUCK_AFTER_MS;

  const notes: string[] = [];
  if (!configured) {
    notes.push(`<p class="failure"><strong>Google Sheets is not configured.</strong> Expenses are stored but not written to the Sheet (set GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_FILE).</p>`);
  }
  if (stuck) {
    notes.push(`<p class="failure"><strong>STUCK:</strong> the oldest unsynced expense has waited since ${esc(fmt(oldest.t!))}.</p>`);
  }
  if (err) {
    notes.push(`<p class="failure"><strong>Last sync error</strong> (${esc(fmt(err.last_attempt_at))}): ${esc(err.last_error)}</p>`);
  }
  if (unparsed > 0) {
    notes.push(`<p class="failure"><strong>${unparsed} expense(s) could not be read</strong> (merchant or amount missing from raw_data). They are saved; the parser needs fixing.</p>`);
  }

  const rows = latest
    .map((e) => {
      const cls = e.sheet_status === "synced" ? "success" : e.sheet_status === "duplicate" ? "" : "failure";
      return `<tr><td>${e.id}</td><td>${esc(fmt(e.received_at))}</td><td>${esc(e.merchant ?? "(unreadable)")}</td>
        <td>${e.amount_cents === null ? "-" : `${(e.amount_cents / 100).toFixed(2)} ${esc(e.currency)}`}</td>
        <td>${esc(e.card ?? "-")}</td><td>${esc(e.source)}</td><td class="${cls}">${esc(e.sheet_status)}</td><td>${e.attempts}</td></tr>`;
    })
    .join("");

  return `<h2>Expenses</h2>
<p>Pending (not in the Sheet yet): <strong class="${pending ? "failure" : "success"}">${pending}</strong>
 · Unreadable: <strong class="${unparsed ? "failure" : "success"}">${unparsed}</strong></p>
${notes.join("\n")}
<table><tr><th>#</th><th>Received</th><th>Merchant</th><th>Amount</th><th>Card</th><th>Source</th><th>Sheet</th><th>Tries</th></tr>
${rows || '<tr><td colspan="8">No expenses yet</td></tr>'}</table>`;
}
