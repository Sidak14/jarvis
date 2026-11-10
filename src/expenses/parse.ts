// Turns the Shortcut's "raw_data" into merchant / amount / card / time.
// We do not yet know exactly what Wallet's "Shortcut Input" looks like once it is sent as JSON,
// so this is tolerant: raw_data can be an object, a JSON string, or "Key: value" lines.
// If it cannot find a merchant and an amount, it returns null and the expense is stored as
// "unparsed" (never dropped). Fix this file, and unparsed rows are re-read on the next sync.

import { resolveTimestamp } from "../datetime";

export interface ParsedExpense {
  merchant: string;
  amount_cents: number;
  currency: string;
  card: string;
  occurred_at: string; // ISO
}

type Pair = [key: string, value: string | number];

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Walk raw_data and collect every (key, value) pair with a text or number value. */
function collect(value: unknown, out: Pair[], depth = 0): void {
  if (depth > 6) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        collect(JSON.parse(text), out, depth + 1);
        return;
      } catch {
        // not JSON, fall through and read it as lines
      }
    }
    for (const line of text.split(/\r?\n|;/)) {
      const m = /^\s*([^:=]{1,40}?)\s*[:=]\s*(.+?)\s*$/.exec(line);
      if (m) out.push([norm(m[1]), m[2]]);
    }
  } else if (Array.isArray(value)) {
    for (const v of value) collect(v, out, depth + 1);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string" || typeof v === "number") out.push([norm(k), v]);
      if (typeof v !== "number") collect(v, out, depth + 1);
    }
  }
}

/** First pair whose key matches one of `keys` (earlier keys win). */
function pick(pairs: Pair[], keys: string[]): string | number | undefined {
  for (const key of keys) {
    const hit = pairs.find(([k, v]) => k === key && String(v).trim() !== "");
    if (hit) return hit[1];
  }
  return undefined;
}

/** "$12.50", "A$12.50", "12.50 AUD", "1,234.50", 12.5 -> integer cents. null if it is not a positive amount. */
export function parseAmountCents(value: unknown): number | null {
  let n: number;
  if (typeof value === "number") {
    n = Math.abs(value);
  } else if (typeof value === "string") {
    const m = /\d[\d,]*(?:\.\d+)?/.exec(value);
    if (!m) return null;
    const digits = /^\d+,\d{1,2}$/.test(m[0]) ? m[0].replace(",", ".") : m[0].replace(/,/g, "");
    n = Number(digits);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) return null;
  return Math.round(n * 100);
}

export function parseRawData(raw: unknown, receivedAt: string): ParsedExpense | null {
  const pairs: Pair[] = [];
  collect(raw, pairs);

  const merchant = pick(pairs, ["merchant", "merchantname", "payee", "name"]);
  const amountRaw = pick(pairs, ["amount", "total", "transactionamount", "value"]);
  if (merchant === undefined || amountRaw === undefined) return null;
  const amount_cents = parseAmountCents(amountRaw);
  if (amount_cents === null) return null;

  const currencyRaw = pick(pairs, ["currency", "currencycode"]);
  const fromAmount = typeof amountRaw === "string" ? /\b([A-Za-z]{3})\b/.exec(amountRaw)?.[1] : undefined;
  const currencyCandidate = String(currencyRaw ?? fromAmount ?? "");
  const currency = /^[A-Za-z]{3}$/.test(currencyCandidate) ? currencyCandidate.toUpperCase() : "AUD";

  const card = pick(pairs, ["cardorpass", "card", "cardname", "passname", "pass", "account"]);

  const when = pick(pairs, ["timestamp", "datetime", "transactiondate", "date", "time"]);
  // A full datetime. A bare date (or no usable date) becomes the moment the tap reached us.
  const occurred_at = resolveTimestamp(when === undefined ? null : String(when), receivedAt) ?? receivedAt;

  return {
    merchant: String(merchant).trim().slice(0, 200),
    amount_cents,
    currency,
    card: card === undefined ? "Unknown" : String(card).trim().slice(0, 100),
    occurred_at,
  };
}
