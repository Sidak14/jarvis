import type Database from "better-sqlite3";

// One shared rule for "is this the same purchase?" used by BOTH paths:
//   - a Wallet tap arriving (looks for an email expense), and
//   - an invoice email arriving (looks for a tap expense).
// The expenses table is the source of truth; the Sheet is only a copy of it.

/** A tap and an email for the same amount + currency within this long are one purchase. */
export const MATCH_WINDOW_MS = 48 * 60 * 60 * 1000;

export type Source = "tap" | "email";

export interface Purchase {
  amount_cents: number;
  currency: string;
  occurred_at: string; // ISO
}

export interface Match {
  id: number;
  merchant: string;
  source: Source;
}

/**
 * The existing expense (from the OTHER source) that this purchase is the same as, or undefined.
 * Each expense can be matched once (merged_at is set on a match), so two real purchases of the
 * same amount on different days still stay two rows. If several fit, the closest in time wins.
 */
export function findCrossSourceMatch(
  db: Database.Database,
  p: Purchase,
  source: Source,
  /** Expenses to treat as already matched (dry-run previews of earlier emails in the same batch). */
  exclude: ReadonlySet<number> = new Set(),
): Match | undefined {
  const other: Source = source === "tap" ? "email" : "tap";
  const rows = db
    .prepare(
      `SELECT id, merchant, source, occurred_at FROM expenses
        WHERE source = ? AND merged_at IS NULL AND sheet_status != 'duplicate' AND parse_status = 'ok'
          AND amount_cents = ? AND currency = ? AND occurred_at IS NOT NULL`,
    )
    .all(other, p.amount_cents, p.currency) as (Match & { occurred_at: string })[];

  const at = Date.parse(p.occurred_at);
  let best: Match | undefined;
  let bestGap = Infinity;
  for (const r of rows) {
    if (exclude.has(r.id)) continue;
    const gap = Math.abs(Date.parse(r.occurred_at) - at);
    if (gap <= MATCH_WINDOW_MS && gap < bestGap) {
      best = { id: r.id, merchant: r.merchant, source: r.source };
      bestGap = gap;
    }
  }
  return best;
}

/** Terminal-style names: "SQ *CAFE 1234", "WOOLWORTHS 4521 SYDNEY", "AMAZON". */
export function isMessyMerchant(name: string): boolean {
  return /[*#]/.test(name) || /\d{3,}/.test(name) || (name === name.toUpperCase() && /[A-Z]{4}/.test(name));
}

/** The incoming name if it is a clear improvement on the existing one, otherwise null (keep it). */
export function betterMerchant(existing: string, incoming: string): string | null {
  const name = incoming.trim();
  if (!name || name === existing) return null;
  return isMessyMerchant(existing) && !isMessyMerchant(name) ? name : null;
}

/** Record that a tap and an email were recognised as one purchase. */
export function markMerged(db: Database.Database, expenseId: number, at: string): void {
  db.prepare(`UPDATE expenses SET merged_at = ? WHERE id = ?`).run(at, expenseId);
}

// ---- Two emails about one purchase ------------------------------------------------------------
// "Your invoice is ready" and "Payment received" for the same charge are two emails but ONE
// expense. They are told apart from two genuine purchases by their kind: a receipt and an invoice
// for the same merchant and amount are a pair; two receipts are two purchases (unless they carry
// the same timestamp, which is the same email sent twice).

export type EmailKind = "receipt" | "invoice";

/** Same email (sent twice) if the times are this close. */
export const REPEAT_WINDOW_MS = 2 * 60 * 1000;
/** An invoice and its receipt can be this far apart. */
export const PAIR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface EmailPeerCandidate {
  id: number;
  merchant: string;
  email_kind: EmailKind | null;
  occurred_at: string;
  amount_cents: number;
  currency: string;
}

const squash = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** "Cloudflare" ~ "Cloudflare, Inc." ~ "SQ *CLOUDFLARE 123". */
export function sameMerchant(a: string, b: string): boolean {
  const x = squash(a);
  const y = squash(b);
  return x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x));
}

/**
 * An existing expense that already accounts for an email like this one: either the same email
 * sent twice, or its invoice/receipt partner. `virtual` lets a dry-run count the emails it has
 * previewed earlier in the same batch, which are not in the database.
 */
export function findEmailPeer(
  db: Database.Database,
  e: { merchant: string; amount_cents: number; currency: string; occurred_at: string; kind: EmailKind | null },
  virtual: EmailPeerCandidate[] = [],
): { id: number; why: "repeat" | "pair" } | undefined {
  const rows = [
    ...(db
      .prepare(
        `SELECT id, merchant, email_kind, occurred_at, amount_cents, currency FROM expenses
          WHERE email_message_id IS NOT NULL AND sheet_status != 'duplicate' AND occurred_at IS NOT NULL
            AND amount_cents = ? AND currency = ?`,
      )
      .all(e.amount_cents, e.currency) as EmailPeerCandidate[]),
    ...virtual.filter((v) => v.amount_cents === e.amount_cents && v.currency === e.currency),
  ];
  const at = Date.parse(e.occurred_at);
  let best: { id: number; why: "repeat" | "pair" } | undefined;
  let bestGap = Infinity;
  for (const r of rows) {
    if (!sameMerchant(r.merchant, e.merchant)) continue;
    const gap = Math.abs(Date.parse(r.occurred_at) - at);
    const why =
      gap <= REPEAT_WINDOW_MS && r.email_kind === e.kind
        ? "repeat"
        : e.kind && r.email_kind && e.kind !== r.email_kind && gap <= PAIR_WINDOW_MS
          ? "pair"
          : undefined;
    if (why && gap < bestGap) {
      best = { id: r.id, why };
      bestGap = gap;
    }
  }
  return best;
}
