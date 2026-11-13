import type Database from "better-sqlite3";
import { dateTime, monthKeyOf } from "../format";
import type { ExpenseRowVM, ExpenseSource, SheetStatus } from "./types";

// The expenses page: rows, totals and filters. Test rows (merchant contains the word TEST) are hidden by default
// and never counted in totals.

/** "JARVIS TEST (delete me)" yes; "Contest Cafe" or "Latest News" no. */
export const isTestMerchant = (merchant: string | null | undefined): boolean => /\btest\b/i.test(merchant ?? "");

interface Row {
  id: number;
  merchant: string | null;
  amount_cents: number | null;
  currency: string;
  card: string | null;
  occurred_at: string | null;
  received_at: string;
  sheet_status: string;
  sheet_row: number | null;
  attempts: number;
  last_error: string | null;
  source: string;
  email_message_id: string | null;
  category: string | null;
  parse_status: string;
}

function sheetStatusOf(r: Row): SheetStatus {
  if (r.sheet_status === "synced") return "synced";
  if (r.sheet_status === "duplicate") return "duplicate";
  if (r.sheet_status === "unparsed" || r.parse_status === "unparsed") return "unreadable";
  return r.last_error ? "failed" : "pending";
}
const sourceOf = (s: string): ExpenseSource => (s === "email" ? "email" : s === "manual" ? "manual" : s === "bank" ? "bank" : "tap");

export function toExpenseRow(r: Row): ExpenseRowVM {
  return {
    id: r.id,
    purchasedAt: new Date(r.occurred_at ?? r.received_at),
    addedAt: new Date(r.received_at),
    merchant: r.merchant ?? "(unreadable)",
    amountCents: r.amount_cents,
    currency: r.currency,
    category: r.category,
    source: sourceOf(r.source),
    sheetStatus: sheetStatusOf(r),
    tries: r.attempts,
    isTest: isTestMerchant(r.merchant),
    card: r.card,
    sheetRow: r.sheet_row,
    emailMessageId: r.email_message_id,
    lastError: r.last_error,
  };
}

export interface ExpenseFilter {
  /** "YYYY-MM" (Sydney). Defaults to the current month. */
  month?: string;
  source?: ExpenseSource;
  category?: string;
  sheet?: SheetStatus;
  q?: string;
  showTests?: boolean;
}

export interface ExpensesVM {
  month: string;
  months: string[];
  prevMonth: string | null;
  nextMonth: string | null;
  tiles: {
    totalCents: number;
    count: number;
    byCategory: { name: string; cents: number }[];
    otherCurrencyCount: number;
    pendingSync: number;
    unreadable: number;
    uncategorised: number;
  };
  rows: ExpenseRowVM[];
  hiddenTests: number;
  categories: string[];
  notes: { kind: "warn" | "error"; text: string }[];
}

const STUCK_AFTER_MS = 60 * 60 * 1000;

export function buildExpenses(db: Database.Database, filter: ExpenseFilter, now: Date, sheetConfigured: boolean): ExpensesVM {
  const all = (db.prepare(`SELECT id, merchant, amount_cents, currency, card, occurred_at, received_at, sheet_status, sheet_row, attempts, last_error, source, email_message_id, category, parse_status FROM expenses ORDER BY COALESCE(occurred_at, received_at) DESC, id DESC`).all() as Row[]).map((r) => ({ vm: toExpenseRow(r), raw: r }));

  const month = filter.month && /^\d{4}-\d{2}$/.test(filter.month) ? filter.month : monthKeyOf(now);
  const monthsSet = new Set<string>([monthKeyOf(now), month]);
  for (const { vm } of all) monthsSet.add(monthKeyOf(vm.purchasedAt));
  const months = [...monthsSet].sort().reverse();
  const idx = months.indexOf(month);

  const inMonth = all.filter(({ vm }) => monthKeyOf(vm.purchasedAt) === month);
  const real = inMonth.filter(({ vm }) => !vm.isTest);
  // Totals: money actually spent. Duplicates (merged with a tap) and unreadable rows are not spend; AUD only.
  const counted = real.filter(({ vm }) => vm.sheetStatus !== "duplicate" && vm.sheetStatus !== "unreadable" && vm.amountCents !== null);
  const aud = counted.filter(({ vm }) => vm.currency === "AUD");
  const byCat = new Map<string, number>();
  for (const { vm } of aud) byCat.set(vm.category ?? "Uncategorised", (byCat.get(vm.category ?? "Uncategorised") ?? 0) + (vm.amountCents ?? 0));

  // Global counters (not tied to the month): what needs attention anywhere.
  const realAll = all.filter(({ vm }) => !vm.isTest);
  const pendingSync = realAll.filter(({ vm }) => vm.sheetStatus === "pending" || vm.sheetStatus === "failed").length;
  const unreadable = realAll.filter(({ vm }) => vm.sheetStatus === "unreadable").length;
  const uncategorised = counted.filter(({ vm }) => vm.category === null).length;

  const q = (filter.q ?? "").trim().toLowerCase();
  const visible = inMonth
    .filter(({ vm }) => filter.showTests || !vm.isTest)
    .filter(({ vm }) => !filter.source || vm.source === filter.source)
    .filter(({ vm }) => !filter.category || (filter.category === "Uncategorised" ? vm.category === null : vm.category === filter.category))
    .filter(({ vm }) => !filter.sheet || vm.sheetStatus === filter.sheet)
    .filter(({ vm }) => !q || vm.merchant.toLowerCase().includes(q) || (vm.category ?? "").toLowerCase().includes(q));

  const notes: ExpensesVM["notes"] = [];
  if (!sheetConfigured) notes.push({ kind: "error", text: "Google Sheets is not configured. Expenses are stored but not written to the Sheet (set GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_FILE)." });
  const oldest = db.prepare(`SELECT MIN(received_at) AS t FROM expenses WHERE sheet_status IN ('pending','syncing')`).get() as { t: string | null };
  if (oldest.t && now.getTime() - Date.parse(oldest.t) > STUCK_AFTER_MS) notes.push({ kind: "error", text: `Stuck: the oldest unsynced expense has waited since ${dateTime(new Date(oldest.t))}.` });
  const err = db
    .prepare(`SELECT last_error, last_attempt_at FROM expenses WHERE last_error IS NOT NULL AND (sheet_status IN ('pending','syncing') OR merchant IS NOT merchant_synced OR category IS NOT category_synced OR purpose IS NOT purpose_synced) ORDER BY last_attempt_at DESC LIMIT 1`)
    .get() as { last_error: string; last_attempt_at: string } | undefined;
  if (err) notes.push({ kind: "error", text: `Last sync error (${dateTime(new Date(err.last_attempt_at))}): ${err.last_error}` });
  if (unreadable > 0) notes.push({ kind: "error", text: `${unreadable} expense(s) could not be read (merchant or amount missing). They are saved; the parser needs fixing.` });

  return {
    month,
    months,
    prevMonth: idx >= 0 && idx < months.length - 1 ? months[idx + 1] : null,
    nextMonth: idx > 0 ? months[idx - 1] : null,
    tiles: {
      totalCents: aud.reduce((s, { vm }) => s + (vm.amountCents ?? 0), 0),
      count: aud.length,
      byCategory: [...byCat.entries()].map(([name, cents]) => ({ name, cents })).sort((a, b) => b.cents - a.cents),
      otherCurrencyCount: counted.length - aud.length,
      pendingSync,
      unreadable,
      uncategorised,
    },
    rows: visible.map((x) => x.vm),
    hiddenTests: filter.showTests ? 0 : inMonth.filter(({ vm }) => vm.isTest).length,
    categories: [...new Set(inMonth.map(({ vm }) => vm.category ?? "Uncategorised"))].sort(),
    notes,
  };
}
