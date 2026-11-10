import type Database from "better-sqlite3";
import { parseRawData } from "./parse";
import { SheetsError, type SheetsClient } from "./sheets";
import { findCrossSourceMatch, markMerged } from "./match";
import { findDuplicate } from "./store";

interface Row {
  id: number;
  merchant: string;
  amount_cents: number;
  currency: string;
  card: string;
  occurred_at: string;
  attempts: number;
  source: string;
}

/** Column F of the Sheet holds this, so we can tell if an expense is already there. */
export const sheetMarker = (id: number) => `jarvis-${id}`;

/** Unparsed rows get another go every sync, so fixing parse.ts rescues them. */
export function reprocessUnparsed(db: Database.Database, log: (m: string) => void): void {
  const rows = db
    .prepare(`SELECT id, raw_payload, received_at FROM expenses WHERE sheet_status = 'unparsed'`)
    .all() as { id: number; raw_payload: string; received_at: string }[];
  for (const r of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(r.raw_payload)?.raw_data;
    } catch {
      continue;
    }
    const e = parseRawData(raw, r.received_at);
    if (!e) continue;
    const sameSource = findDuplicate(db, e, r.raw_payload, r.received_at, r.id);
    const emailMatch = sameSource ? undefined : findCrossSourceMatch(db, e, "tap"); // already recorded from an email
    if (emailMatch) markMerged(db, emailMatch.id, r.received_at);
    const dup = sameSource ?? emailMatch?.id;
    db.prepare(
      `UPDATE expenses SET merchant=?, amount_cents=?, currency=?, card=?, occurred_at=?,
              parse_status='ok', sheet_status=?, duplicate_of=? WHERE id=?`,
    ).run(e.merchant, e.amount_cents, e.currency, e.card, e.occurred_at, dup ? "duplicate" : "pending", dup ?? null, r.id);
    log(`expense #${r.id} is readable now: ${dup ? `duplicate of #${dup}` : "queued for the Sheet"}`);
  }
}

/**
 * Write every pending expense to the Sheet, oldest first. An expense becomes 'synced' only
 * after Google confirms the write. Throws if any expense failed, so the run shows as a failure.
 * `sheets` is null when Google is not configured: expenses just wait.
 */
export async function syncExpenses(opts: {
  db: Database.Database;
  sheets: SheetsClient | null;
  log: (m: string) => void;
  now?: Date;
}): Promise<void> {
  const { db, sheets, log } = opts;
  const now = opts.now ?? new Date();

  reprocessUnparsed(db, log);

  if (!sheets) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM expenses WHERE sheet_status IN ('pending','syncing')`).get() as { n: number }).n;
    log(`Google Sheets is not configured (GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_FILE). ${n} expense(s) waiting.`);
    return;
  }

  const next = db.prepare(
    `SELECT id, merchant, amount_cents, currency, card, occurred_at, attempts, source FROM expenses
      WHERE sheet_status IN ('pending','syncing') AND id > ? ORDER BY id LIMIT 1`,
  );
  const failures: string[] = [];
  let synced = 0;
  let lastId = 0;

  for (let row = next.get(lastId) as Row | undefined; row; row = next.get(lastId) as Row | undefined) {
    lastId = row.id;
    db.prepare(
      `UPDATE expenses SET sheet_status='syncing', attempts=attempts+1, last_attempt_at=? WHERE id=?`,
    ).run(now.toISOString(), row.id);
    try {
      // If an earlier attempt may have reached Google (timeout, crash), look before writing.
      let sheetRow = row.attempts > 0 ? await sheets.findRow(sheetMarker(row.id)) : null;
      if (sheetRow !== null) {
        log(`expense #${row.id} was already in the Sheet (row ${sheetRow}), not writing it again`);
      } else {
        sheetRow = await sheets.appendRow([
          new Date(row.occurred_at).toLocaleString("sv-SE"), // "2026-11-10 12:27:00", this Mac's time
          row.merchant,
          row.amount_cents / 100,
          row.currency,
          row.card,
          sheetMarker(row.id),
          row.source, // column G: "tap" or "email"
        ]);
        log(`expense #${row.id} written to the Sheet${sheetRow ? ` (row ${sheetRow})` : ""}`);
      }
      db.prepare(
        `UPDATE expenses SET sheet_status='synced', sheet_row=?, last_error=NULL, merchant_synced=? WHERE id=?`,
      ).run(sheetRow, row.merchant, row.id);
      synced++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.prepare(`UPDATE expenses SET sheet_status='pending', last_error=? WHERE id=?`).run(message, row.id);
      log(`expense #${row.id} FAILED, will retry: ${message}`);
      failures.push(`#${row.id}`);
      // Auth, network or Google trouble affects every row: stop, do not hammer Google.
      if (!(err instanceof SheetsError) || err.fatal) break;
    }
  }

  // A merged expense can get a better merchant name after it was already written. Push just that cell.
  if (!failures.length) await updateImprovedMerchants(db, sheets, log, failures);

  log(`synced ${synced}, failed ${failures.length}`);
  if (failures.length) throw new Error(`could not write ${failures.join(", ")} to the Sheet (see log above)`);
}

/** Rows already in the Sheet whose merchant in the database is now different (a better name from an email). */
async function updateImprovedMerchants(
  db: Database.Database,
  sheets: SheetsClient,
  log: (m: string) => void,
  failures: string[],
): Promise<void> {
  const rows = db
    .prepare(
      `SELECT id, merchant FROM expenses WHERE sheet_status = 'synced' AND merchant IS NOT merchant_synced ORDER BY id`,
    )
    .all() as { id: number; merchant: string }[];
  for (const r of rows) {
    try {
      // Look the row up by its id marker: the user may have sorted or deleted rows since.
      const sheetRow = await sheets.findRow(sheetMarker(r.id));
      if (sheetRow === null) {
        log(`expense #${r.id} is no longer in the Sheet, not updating its merchant`);
      } else {
        await sheets.setMerchant(sheetRow, r.merchant);
        log(`expense #${r.id} merchant updated in the Sheet (row ${sheetRow}): ${r.merchant}`);
      }
      db.prepare(`UPDATE expenses SET merchant_synced = ?, last_error = NULL WHERE id = ?`).run(r.merchant, r.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.prepare(`UPDATE expenses SET last_error = ?, last_attempt_at = ? WHERE id = ?`).run(message, new Date().toISOString(), r.id);
      log(`expense #${r.id} merchant update FAILED, will retry: ${message}`);
      failures.push(`#${r.id} (merchant)`);
      if (!(err instanceof SheetsError) || err.fatal) break;
    }
  }
}
