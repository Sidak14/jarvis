import type Database from "better-sqlite3";
import { EMAIL_CARD } from "../gmail/settings";
import {
  betterMerchant,
  findCrossSourceMatch,
  findEmailPeer,
  markMerged,
  type EmailKind,
  type EmailPeerCandidate,
  type Purchase,
} from "./match";

// Adding an expense that came from an invoice email, through the same pipeline as a Wallet tap.

export interface EmailPurchase extends Purchase {
  messageId: string;
  merchant: string;
  kind: EmailKind | null;
}

export type EmailDecision =
  | { kind: "already"; id: number } // this exact email is already an expense
  | { kind: "duplicate"; id: number; why: "repeat" | "pair" } // same email again, or its invoice/receipt partner
  | { kind: "merge"; id: number; merchant: string; newMerchant: string | null } // same purchase as a tap
  | { kind: "add" };

/** What a dry-run has previewed so far in this batch, so it can show repeats, pairs and merges faithfully. */
export interface Preview {
  virtual: EmailPeerCandidate[];
  usedTaps: Set<number>;
}
export const newPreview = (): Preview => ({ virtual: [], usedTaps: new Set() });

/**
 * Decide what to do with an email purchase, WITHOUT changing anything. Dry-run uses this alone;
 * the real thing (storeEmailExpense) uses the same function, so a preview is exactly what happens.
 * Order: this email already seen -> same purchase as an earlier email (repeat or invoice/receipt
 * pair) -> same purchase as a Wallet tap -> a new expense.
 */
export function decideEmailExpense(db: Database.Database, e: EmailPurchase, preview?: Preview): EmailDecision {
  const same = db.prepare(`SELECT id FROM expenses WHERE email_message_id = ?`).get(e.messageId) as { id: number } | undefined;
  if (same) return { kind: "already", id: same.id };

  const peer = findEmailPeer(db, e, preview?.virtual);
  if (peer) return { kind: "duplicate", id: peer.id, why: peer.why };

  const tap = findCrossSourceMatch(db, e, "email", preview?.usedTaps);
  if (tap) return { kind: "merge", id: tap.id, merchant: tap.merchant, newMerchant: betterMerchant(tap.merchant, e.merchant) };
  return { kind: "add" };
}

/** Dry-run: remember what a previewed email would have created, for the emails after it. */
export function notePreview(preview: Preview, e: EmailPurchase, d: EmailDecision): void {
  const candidate = (id: number, merchant: string): EmailPeerCandidate => ({
    id,
    merchant,
    email_kind: e.kind,
    occurred_at: e.occurred_at,
    amount_cents: e.amount_cents,
    currency: e.currency,
  });
  if (d.kind === "add") preview.virtual.push(candidate(0, e.merchant));
  if (d.kind === "merge") {
    preview.usedTaps.add(d.id);
    preview.virtual.push(candidate(d.id, d.merchant));
  }
}

export type EmailStoreResult =
  | { outcome: "added"; id: number }
  | { outcome: "merged"; id: number; merchantImproved: boolean }
  | { outcome: "duplicate"; id: number; why: "repeat" | "pair" }
  | { outcome: "already"; id: number };

/** Apply the decision. Never inserts a second expense for a purchase that is already recorded. */
export function storeEmailExpense(db: Database.Database, e: EmailPurchase, now = new Date()): EmailStoreResult {
  const at = now.toISOString();
  return db.transaction((): EmailStoreResult => {
    const d = decideEmailExpense(db, e);
    if (d.kind === "already") return { outcome: "already", id: d.id };

    if (d.kind === "merge") {
      // Same purchase as a tap: attach the email to it, and take the email's merchant name
      // if the tap's was a messy terminal string.
      db.prepare(
        `UPDATE expenses SET email_message_id = ?, email_kind = ?, merchant = COALESCE(?, merchant) WHERE id = ?`,
      ).run(e.messageId, e.kind, d.newMerchant, d.id);
      markMerged(db, d.id, at);
      return { outcome: "merged", id: d.id, merchantImproved: d.newMerchant !== null };
    }

    // An ignored email (repeat or partner) is still recorded, under its own message id, but never synced.
    const duplicateOf = d.kind === "duplicate" ? d.id : null;
    const id = Number(
      db
        .prepare(
          `INSERT INTO expenses (merchant, amount_cents, currency, card, occurred_at, received_at,
                                 sheet_status, raw_payload, parse_status, duplicate_of, source, email_message_id, email_kind)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, 'email', ?, ?)`,
        )
        .run(
          e.merchant,
          e.amount_cents,
          e.currency,
          EMAIL_CARD,
          e.occurred_at,
          at,
          duplicateOf ? "duplicate" : "pending",
          // Only the extracted fields, never the email text.
          JSON.stringify({ source: "email", merchant: e.merchant, amount_cents: e.amount_cents, currency: e.currency, occurred_at: e.occurred_at, kind: e.kind }),
          duplicateOf,
          e.messageId,
          e.kind,
        ).lastInsertRowid,
    );
    return d.kind === "duplicate" ? { outcome: "duplicate", id: d.id, why: d.why } : { outcome: "added", id };
  })();
}
