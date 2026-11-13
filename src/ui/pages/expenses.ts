import { BarList, Banner, Card, DataTable, EmptyState, Money, Moment, PageLayout, Section, StatTile, StatusPill, TileRow, type Row, RelativeTime } from "../components";
import { dateTime, dayAndTime, money, monthLabel, plural } from "../format";
import { h, raw, type Html } from "../html";
import type { ExpenseFilter, ExpensesVM } from "../vm/expenses";
import { sheetPill, sourcePill } from "./shared";

// Expenses: month selector, tiles, filters (plain GET form, so it works without JavaScript) and the table.

const SOURCES = ["tap", "email", "bank", "manual"] as const;
const SHEETS: { value: string; label: string }[] = [
  { value: "synced", label: "Synced" },
  { value: "pending", label: "Pending" },
  { value: "failed", label: "Failed" },
  { value: "duplicate", label: "Merged" },
  { value: "unreadable", label: "Unreadable" },
];

function query(f: ExpenseFilter & { month: string }, over: Partial<Record<string, string>> = {}): string {
  const p = new URLSearchParams();
  const all: Record<string, string | undefined> = { month: f.month, source: f.source, category: f.category, sheet: f.sheet, q: f.q, tests: f.showTests ? "1" : undefined, ...over };
  for (const [k, v] of Object.entries(all)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

function toolbar(vm: ExpensesVM, f: ExpenseFilter): Html {
  const opt = (value: string, label: string, selected: boolean) => h`<option value="${value}"${raw(selected ? " selected" : "")}>${label}</option>`;
  return h`<form class="toolbar" method="get" action="/expenses" data-autosubmit>
<input type="hidden" name="month" value="${vm.month}">
<label>Source<select name="source">${opt("", "All sources", !f.source)}${SOURCES.map((s) => opt(s, s[0].toUpperCase() + s.slice(1), f.source === s))}</select></label>
<label>Category<select name="category">${opt("", "All categories", !f.category)}${vm.categories.map((c) => opt(c, c, f.category === c))}</select></label>
<label>Sheet<select name="sheet">${opt("", "Any status", !f.sheet)}${SHEETS.map((s) => opt(s.value, s.label, f.sheet === s.value))}</select></label>
<label>Search<input type="search" name="q" value="${f.q ?? ""}" placeholder="Merchant or category"></label>
<label class="check"><input type="checkbox" name="tests" value="1"${raw(f.showTests ? " checked" : "")}> Show test rows</label>
<button class="btn" type="submit">Apply</button>
</form>`;
}

function detail(r: ExpensesVM["rows"][number], now: Date): Html {
  return h`<dl class="facts">
<div><dt>Expense</dt><dd>#${r.id}</dd></div>
<div><dt>Card / receipt</dt><dd>${r.card ?? "—"}</dd></div>
<div><dt>Sheet row</dt><dd>${r.sheetRow === null ? "not in the Sheet yet" : `row ${r.sheetRow}`}</dd></div>
<div><dt>Sync tries</dt><dd>${r.tries}</dd></div>
<div><dt>Added to Jarvis</dt><dd>${Moment(r.addedAt, dayAndTime(r.addedAt, now))}</dd></div>
${r.lastError ? h`<div><dt>Last error</dt><dd>${r.lastError}</dd></div>` : ""}
${r.emailMessageId ? h`<div><dt>Email</dt><dd><a href="https://mail.google.com/mail/u/0/#all/${encodeURIComponent(r.emailMessageId)}" target="_blank" rel="noreferrer">Open in Gmail</a></dd></div>` : ""}
</dl>`;
}

export function expensesPage(vm: ExpensesVM, f: ExpenseFilter, now: Date): string {
  const q = { ...f, month: vm.month };
  const nav = h`<div class="month-nav">
${vm.prevMonth ? h`<a class="btn btn-quiet" href="/expenses${query(q, { month: vm.prevMonth })}" aria-label="Previous month">‹</a>` : ""}
<span class="current">${monthLabel(vm.month)}</span>
${vm.nextMonth ? h`<a class="btn btn-quiet" href="/expenses${query(q, { month: vm.nextMonth })}" aria-label="Next month">›</a>` : ""}
</div>`;

  const t = vm.tiles;
  const tiles = TileRow([
    StatTile({ label: "Total", value: money(t.totalCents), sub: t.otherCurrencyCount ? `+ ${plural(t.otherCurrencyCount, "expense")} in other currencies` : "AUD" }),
    StatTile({ label: "Expenses", value: String(t.count), sub: t.uncategorised ? `${t.uncategorised} uncategorised` : "all categorised" }),
    StatTile({ label: "Pending sync", value: String(t.pendingSync), sub: "not in the Sheet yet", state: t.pendingSync ? "warn" : "ok" }),
    StatTile({ label: "Unreadable", value: String(t.unreadable), sub: "merchant or amount missing", state: t.unreadable ? "error" : "ok" }),
  ]);
  const cats = Card({ title: "By category", body: t.byCategory.length ? BarList(t.byCategory.map((c) => ({ label: c.name, value: c.cents, text: money(c.cents) }))) : EmptyState("Nothing spent this month") });

  const rows: Row[] = vm.rows.map((r) => ({
    className: r.sheetStatus === "failed" || r.sheetStatus === "unreadable" ? "row-error" : r.sheetStatus === "pending" ? "row-warn" : undefined,
    attrs: r.isTest ? { test: "1" } : undefined,
    detail: detail(r, now),
    cells: [
      { html: h`<time datetime="${r.purchasedAt.toISOString()}" title="${dateTime(r.purchasedAt)}">${dayAndTime(r.purchasedAt, now)}</time>`, sort: r.purchasedAt.getTime() },
      { html: RelativeTime(r.addedAt, now), sort: r.addedAt.getTime() },
      { html: h`${r.merchant}${r.isTest ? h` ${StatusPill("off", "Test")}` : ""}`, sort: r.merchant.toLowerCase() },
      { html: Money(r.amountCents, r.currency), sort: r.amountCents ?? 0 },
      h`${r.category ?? h`<span class="muted">Uncategorised</span>`}`,
      sourcePill(r.source),
      sheetPill(r.sheetStatus),
    ],
  }));
  const table = DataTable({
    caption: `Expenses, ${monthLabel(vm.month)}`,
    id: "expenses",
    columns: [
      { label: "Purchased", sort: "num" },
      { label: "Added", sort: "num" },
      { label: "Merchant", sort: "text" },
      { label: "Amount", align: "right", sort: "num" },
      { label: "Category", sort: "text" },
      { label: "Source" },
      { label: "Sheet" },
    ],
    rows,
    empty: EmptyState("No expenses match", f.source || f.category || f.sheet || f.q ? "Try clearing a filter." : "Nothing was logged in this month."),
  });

  const body = h`${vm.notes.map((n) => Banner(n.kind, n.text))}
${nav}
${tiles}
<div class="split">${cats}${toolbar(vm, f)}</div>
${Section("All expenses", h`${vm.hiddenTests ? h`<p class="note">${plural(vm.hiddenTests, "test row")} hidden and left out of the totals. <a href="/expenses${query(q, { tests: "1" })}">Show test rows</a></p>` : ""}${table}`, vm.rows.length)}`;
  return PageLayout({ title: "Expenses", active: "expenses", body, now });
}
