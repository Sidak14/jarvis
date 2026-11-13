import { esc } from "../html";
import { h, join, raw, Html, type Part } from "./html";
import { dateTime, dateTimeFull, money, relativeTime } from "./format";

// The reusable parts of every page, in one place. Each returns Html; everything interpolated is escaped by `h`
// (see html.ts), so merchant names, chat names and plan titles can not break the page.

// ---- Status pills: never colour alone. An icon AND a word.
export type PillKind = "ok" | "warn" | "error" | "off" | "dry" | "live" | "info";
const PILLS: Record<PillKind, { icon: string; label: string }> = {
  ok: { icon: "✓", label: "OK" },
  warn: { icon: "!", label: "Needs attention" },
  error: { icon: "✕", label: "Failing" },
  off: { icon: "–", label: "Off" },
  dry: { icon: "◐", label: "Dry run" },
  live: { icon: "●", label: "Live" },
  info: { icon: "i", label: "Info" },
};
export function StatusPill(kind: PillKind, label?: string): Html {
  const p = PILLS[kind];
  return h`<span class="pill pill-${kind}"><span class="pill-icon" aria-hidden="true">${p.icon}</span>${label ?? p.label}</span>`;
}

// ---- Small values
/** "5 min ago", with the full Sydney time on hover. `null` shows `fallback`. */
export function RelativeTime(d: Date | null | undefined, now: Date, fallback = "never"): Html {
  if (!d) return h`<span class="muted">${fallback}</span>`;
  return h`<time class="rel" datetime="${d.toISOString()}" title="${dateTimeFull(d)}">${relativeTime(d, now)}</time>`;
}
/** An absolute Sydney time ("Fri 13 Nov 2026, 12:27 pm"), full time on hover. */
export function Moment(d: Date | null | undefined, text?: string): Html {
  if (!d) return h`<span class="muted">—</span>`;
  return h`<time datetime="${d.toISOString()}" title="${dateTimeFull(d)}">${text ?? dateTime(d)}</time>`;
}
export function Money(cents: number | null | undefined, currency = "AUD"): Html {
  if (cents === null || cents === undefined) return h`<span class="muted">—</span>`;
  return h`<span class="money num">${money(cents, currency)}</span>`;
}
export const Mono = (text: string) => h`<code class="mono">${text}</code>`;
export const Muted = (text: Part) => h`<span class="muted">${text}</span>`;

// ---- Banner, EmptyState
export type BannerKind = "ok" | "warn" | "error" | "info";
export interface BannerItem {
  text: string;
  link?: string;
  label?: string;
}
export function Banner(kind: BannerKind, title: string, items: BannerItem[] = []): Html {
  const icon = kind === "ok" ? "✓" : kind === "error" ? "✕" : kind === "warn" ? "!" : "i";
  const role = kind === "error" ? "alert" : "status";
  const list = items.length
    ? h`<ul class="banner-list">${items.map((i) => h`<li>${i.link ? h`<a href="${i.link}">${i.label ?? i.text}</a>` : i.text}${i.link && i.label ? h` <span class="muted">${i.text}</span>` : ""}</li>`)}</ul>`
    : "";
  return h`<section class="banner banner-${kind}" role="${role}"><span class="banner-icon" aria-hidden="true">${icon}</span><div><p class="banner-title">${title}</p>${list}</div></section>`;
}
export function EmptyState(title: string, hint?: string): Html {
  return h`<div class="empty"><p class="empty-title">${title}</p>${hint ? h`<p class="muted">${hint}</p>` : ""}</div>`;
}

// ---- Tiles and cards
export interface StatTileProps {
  label: string;
  value: Part;
  sub?: Part;
  state?: "ok" | "warn" | "error" | "off";
  href?: string;
}
export function StatTile(t: StatTileProps): Html {
  const body = h`<span class="tile-label">${t.label}</span><span class="tile-value num">${t.value}</span>${t.sub ? h`<span class="tile-sub">${t.sub}</span>` : ""}`;
  const cls = `tile${t.state ? ` tile-${t.state}` : ""}`;
  return t.href ? h`<a class="${cls}" href="${t.href}">${body}</a>` : h`<div class="${cls}">${body}</div>`;
}
export const TileRow = (tiles: Html[]): Html => h`<div class="tiles">${tiles}</div>`;

export function Card(opts: { title: Part; pill?: Html; body: Part; footer?: Part; href?: string; id?: string }): Html {
  const title = opts.href ? h`<a href="${opts.href}">${opts.title}</a>` : h`${opts.title}`;
  return h`<section class="card"${opts.id ? raw(` id="${opts.id.replace(/[^a-z0-9_-]/gi, "")}"`) : ""}><header class="card-head"><h2 class="card-title">${title}</h2>${opts.pill ?? ""}</header><div class="card-body">${opts.body}</div>${opts.footer ? h`<footer class="card-foot">${opts.footer}</footer>` : ""}</section>`;
}
export const Section = (title: string, body: Part, count?: number): Html =>
  h`<section class="section"><h2 class="section-title">${title}${count === undefined ? "" : h` <span class="count">${count}</span>`}</h2>${body}</section>`;

/** A <dl> of label/value pairs (values may be Html). */
export function Facts(facts: { label: string; value: Part }[]): Html {
  return h`<dl class="facts">${facts.map((f) => h`<div><dt>${f.label}</dt><dd>${f.value}</dd></div>`)}</dl>`;
}

// ---- DataTable: a real table with a caption; under 640px every row becomes a stacked card (data-label on each cell).
/** A cell is plain text, Html, or {html, sort, mobileHide}: mobileHide leaves out a default-looking value in the stacked cards. */
export type Cell = Html | string | number | { html: Html; sort?: string | number; mobileHide?: boolean };
export interface Column {
  label: string;
  align?: "right";
  sort?: "text" | "num";
  hideLabel?: boolean;
}
export interface Row {
  cells: Cell[];
  /** Expandable details, shown under the row when its arrow is pressed. */
  detail?: Html;
  className?: string;
  attrs?: Record<string, string>;
}
let tableCounter = 0;
export function DataTable(opts: { caption: string; columns: Column[]; rows: Row[]; empty: Html; sortable?: boolean; id?: string }): Html {
  if (opts.rows.length === 0) return opts.empty;
  const id = (opts.id ?? `t${++tableCounter}`).replace(/[^a-z0-9_-]/gi, "");
  const hasDetail = opts.rows.some((r) => r.detail);
  const head = opts.columns.map((c, i) => {
    const sortable = opts.sortable !== false && c.sort;
    const cls = c.align === "right" ? "num" : "";
    return sortable
      ? h`<th scope="col" class="${cls}"><button type="button" class="sort" data-sort="${c.sort}" data-col="${i}">${c.label}<span class="sort-icon" aria-hidden="true"></span></button></th>`
      : h`<th scope="col" class="${cls}">${c.label}</th>`;
  });
  const body = opts.rows.map((r, ri) => {
    const detailId = `${id}-d${ri}`;
    const attrs = Object.entries(r.attrs ?? {}).map(([k, v]) => raw(` data-${k.replace(/[^a-z-]/gi, "")}="${String(v).replace(/[^\w .:/-]/g, "")}"`));
    const cells = r.cells.map((cell, ci) => {
      const plain = cell instanceof Html || typeof cell === "string" || typeof cell === "number";
      const html = cell instanceof Html ? cell : plain ? h`${cell}` : cell.html;
      const sort = plain || cell.sort === undefined ? "" : raw(` data-sort="${esc(cell.sort)}"`);
      const col = opts.columns[ci];
      const toggle = hasDetail && ci === 0 && r.detail ? h`<button type="button" class="expand" aria-expanded="false" aria-controls="${detailId}" aria-label="Show details"><span aria-hidden="true">▸</span></button>` : "";
      const classes = [col.align === "right" ? "num" : "", !plain && cell.mobileHide ? "hide-sm" : ""].filter(Boolean).join(" ");
      return h`<td${raw(classes ? ` class="${classes}"` : "")}${sort} data-label="${col.hideLabel ? "" : col.label}">${toggle}${html}</td>`;
    });
    const main = h`<tr${raw(r.className ? ` class="${r.className.replace(/[^\w -]/g, "")}"` : "")}${attrs}>${cells}</tr>`;
    const detail = r.detail ? h`<tr class="detail" id="${detailId}" hidden><td colspan="${opts.columns.length}">${r.detail}</td></tr>` : "";
    return join([main, detail]);
  });
  return h`<div class="table-wrap"><table class="data" id="${id}"><caption>${opts.caption}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ---- A small progress meter (plays toward a threshold): dots when small, with the numbers as text too.
export function Progress(value: number, max: number, label: string): Html {
  const dots = max <= 10 ? Array.from({ length: max }, (_, i) => h`<span class="dot${i < value ? " on" : ""}"></span>`) : "";
  const pct = Math.min(100, Math.round((value / Math.max(1, max)) * 100));
  return h`<span class="progress" role="img" aria-label="${label}">${dots || h`<span class="bar"><span style="width:${pct}%"></span></span>`}<span class="progress-text num">${Math.min(value, 99)} / ${max}</span></span>`;
}

/** A horizontal bar list (spend by category). */
export function BarList(items: { label: string; value: number; text: Part }[]): Html {
  const max = Math.max(1, ...items.map((i) => i.value));
  return h`<ul class="bars">${items.map((i) => h`<li><span class="bar-label">${i.label}</span><span class="bar-track" aria-hidden="true"><span style="width:${Math.round((i.value / max) * 100)}%"></span></span><span class="bar-value num">${i.text}</span></li>`)}</ul>`;
}

// ---- The page shell
export type NavKey = "overview" | "expenses" | "plans" | "spotify" | "invoices" | "jobs";
const NAV: { key: NavKey; label: string; href: string }[] = [
  { key: "overview", label: "Overview", href: "/" },
  { key: "expenses", label: "Expenses", href: "/expenses" },
  { key: "plans", label: "Plans", href: "/plans" },
  { key: "spotify", label: "Spotify", href: "/spotify" },
  { key: "invoices", label: "Invoices", href: "/gmail" },
  { key: "jobs", label: "Jobs", href: "/jobs" },
];

/** Bump when dashboard.css / dashboard.js change, so browsers fetch the new files. */
export const ASSET_VERSION = "1";

export function PageLayout(opts: { title: string; active: NavKey | null; body: Html; now: Date; subtitle?: string; bare?: boolean }): string {
  const nav = NAV.map((n) => h`<a href="${n.href}"${raw(opts.active === n.key ? ` aria-current="page"` : "")}>${n.label}</a>`);
  return h`<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${opts.title} · Jarvis</title>
<link rel="stylesheet" href="/assets/dashboard.css?v=${ASSET_VERSION}">
<script src="/assets/dashboard.js?v=${ASSET_VERSION}" defer></script>
</head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="topbar"><div class="topbar-in">
  <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">J</span>Jarvis</a>
  <nav class="nav" aria-label="Main">${nav}</nav>
  <label class="auto"><input type="checkbox" id="auto-refresh"> <span>Auto-refresh</span></label>
</div></header>
<main id="main" class="page">
${opts.bare ? "" : h`<div class="page-head"><h1>${opts.title}</h1>${opts.subtitle ? h`<p class="muted">${opts.subtitle}</p>` : ""}<p class="stamp muted">Updated <time class="rel" datetime="${opts.now.toISOString()}" title="${dateTimeFull(opts.now)}">just now</time> · Sydney time</p></div>`}
${opts.body}
</main></body></html>`.value;
}
