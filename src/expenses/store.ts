import type Database from "better-sqlite3";
import { parseRawData, type ParsedExpense } from "./parse";

/** The same merchant + amount + card within this long counts as one tap. */
export const DEDUPE_WINDOW_MS = 2 * 60 * 1000;

export interface StoreResult {
  id: number;
  outcome: "stored" | "duplicate" | "unparsed";
  duplicateOf?: number;
}

/** Id of an earlier, non-duplicate row that looks like the same tap, or undefined. */
export function findDuplicate(
  db: Database.Database,
  e: ParsedExpense | null,
  rawPayload: string,
  receivedAt: string,
  selfId = 0,
): number | undefined {
  const from = new Date(Date.parse(receivedAt) - DEDUPE_WINDOW_MS).toISOString();
  const row = (
    e
      ? db
          .prepare(
            `SELECT id FROM expenses
              WHERE sheet_status != 'duplicate' AND id != ? AND received_at BETWEEN ? AND ?
                AND lower(trim(merchant)) = lower(trim(?)) AND amount_cents = ?
                AND lower(trim(card)) = lower(trim(?))
              ORDER BY id LIMIT 1`,
          )
          .get(selfId, from, receivedAt, e.merchant, e.amount_cents, e.card)
      : // Nothing readable to compare, so only an identical payload counts as the same tap.
        db
          .prepare(
            `SELECT id FROM expenses
              WHERE sheet_status != 'duplicate' AND id != ? AND received_at BETWEEN ? AND ?
                AND raw_payload = ?
              ORDER BY id LIMIT 1`,
          )
          .get(selfId, from, receivedAt, rawPayload)
  ) as { id: number } | undefined;
  return row?.id;
}

/** Store one webhook body. This is the only thing the webhook waits for. */
export function storeExpense(
  db: Database.Database,
  body: { raw_data: unknown },
  now = new Date(),
): StoreResult {
  const rawPayload = JSON.stringify(body);
  const receivedAt = now.toISOString();
  const parsed = parseRawData(body.raw_data, receivedAt);

  // One transaction, so the duplicate check and the insert cannot interleave.
  const run = db.transaction((): StoreResult => {
    const duplicateOf = findDuplicate(db, parsed, rawPayload, receivedAt);
    const status = duplicateOf ? "duplicate" : parsed ? "pending" : "unparsed";
    const id = Number(
      db
        .prepare(
          `INSERT INTO expenses (merchant, amount_cents, currency, card, occurred_at, received_at,
                                 sheet_status, raw_payload, parse_status, duplicate_of)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          duplicateOf ?? null,
        ).lastInsertRowid,
    );
    if (duplicateOf) return { id, outcome: "duplicate", duplicateOf };
    return { id, outcome: parsed ? "stored" : "unparsed" };
  });
  return run();
}
