import type Database from "better-sqlite3";
import { findCrossSourceMatch, markMerged, type Source } from "./match";
import { parseRawData, type ParsedExpense } from "./parse";

/** The same merchant + amount + card within this long counts as one tap (or one email). */
export const DEDUPE_WINDOW_MS = 2 * 60 * 1000;

export interface StoreResult {
  id: number;
  /** merged = the same purchase was already recorded from an email; this tap is not a new expense. */
  outcome: "stored" | "duplicate" | "unparsed" | "merged";
  duplicateOf?: number;
}

/** Id of an earlier, non-duplicate row from the SAME source that looks like the same tap/email, or undefined. */
export function findDuplicate(
  db: Database.Database,
  e: ParsedExpense | null,
  rawPayload: string,
  receivedAt: string,
  selfId = 0,
  source: Source = "tap",
): number | undefined {
  const from = new Date(Date.parse(receivedAt) - DEDUPE_WINDOW_MS).toISOString();
  const row = (
    e
      ? db
          .prepare(
            `SELECT id FROM expenses
              WHERE sheet_status != 'duplicate' AND source = ? AND id != ? AND received_at BETWEEN ? AND ?
                AND lower(trim(merchant)) = lower(trim(?)) AND amount_cents = ?
                AND lower(trim(card)) = lower(trim(?))
              ORDER BY id LIMIT 1`,
          )
          .get(source, selfId, from, receivedAt, e.merchant, e.amount_cents, e.card)
      : // Nothing readable to compare, so only an identical payload counts as the same tap.
        db
          .prepare(
            `SELECT id FROM expenses
              WHERE sheet_status != 'duplicate' AND source = ? AND id != ? AND received_at BETWEEN ? AND ?
                AND raw_payload = ?
              ORDER BY id LIMIT 1`,
          )
          .get(source, selfId, from, receivedAt, rawPayload)
  ) as { id: number } | undefined;
  return row?.id;
}

/**
 * Store one webhook request. This is the only thing the webhook waits for, and it keeps
 * everything: a body we cannot read is stored as 'unparsed' instead of being rejected.
 * `body` is whatever JSON arrived (or {"non_json_body": "..."} if it was not JSON).
 */
export function storeExpense(db: Database.Database, body: unknown, now = new Date()): StoreResult {
  const rawPayload = JSON.stringify(body) ?? "null";
  const receivedAt = now.toISOString();
  const rawData =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { raw_data?: unknown }).raw_data
      : undefined;
  const parsed = parseRawData(rawData, receivedAt);

  // One transaction, so the duplicate checks and the insert cannot interleave.
  const run = db.transaction((): StoreResult => {
    // 1. The same tap fired twice (same source): the old ~2 minute rule.
    const duplicateOf = findDuplicate(db, parsed, rawPayload, receivedAt);
    // 2. The same purchase already recorded from an email: merge, do not add a second expense.
    const emailMatch = !duplicateOf && parsed ? findCrossSourceMatch(db, parsed, "tap") : undefined;

    const ignoredAs = duplicateOf ?? emailMatch?.id;
    const status = ignoredAs ? "duplicate" : parsed ? "pending" : "unparsed";
    const id = Number(
      db
        .prepare(
          `INSERT INTO expenses (merchant, amount_cents, currency, card, occurred_at, received_at,
                                 sheet_status, raw_payload, parse_status, duplicate_of, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'tap')`,
        )
        .run(
          parsed?.merchant ?? null,
          parsed?.amount_cents ?? null,
          parsed?.currency ?? "AUD",
          parsed?.card ?? null,
          parsed?.occurred_at ?? null,
          receivedAt,
          status,
          rawPayload,
          parsed ? "ok" : "unparsed",
          ignoredAs ?? null,
        ).lastInsertRowid,
    );
    if (duplicateOf) return { id, outcome: "duplicate", duplicateOf };
    if (emailMatch) {
      // The email row is already the expense (and is already in, or on its way to, the Sheet).
      // The better merchant name is the email's, so nothing changes there.
      markMerged(db, emailMatch.id, receivedAt);
      return { id, outcome: "merged", duplicateOf: emailMatch.id };
    }
    return { id, outcome: parsed ? "stored" : "unparsed" };
  });
  return run();
}
