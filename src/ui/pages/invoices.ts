import { Banner, Card, DataTable, EmptyState, Moment, PageLayout, RelativeTime, Section, StatTile, StatusPill, TileRow } from "../components";
import { dateTimeFull, duration, plural, shortId, usd } from "../format";
import { h, raw } from "../html";
import type { EmailResult, GmailVM } from "../vm/gmail";

// Invoices (Gmail): tiles, last run vs all time, AI usage, Run now, and the processed-emails table with a result filter.

const resultPill = (r: EmailResult, dry: boolean) => {
  const pill = r === "invoice" ? StatusPill("ok", "Invoice") : r === "error" ? StatusPill("error", "Error") : StatusPill("off", "Not invoice");
  return dry ? h`${pill} ${StatusPill("dry")}` : pill;
};

export function invoicesPage(vm: GmailVM, now: Date, opts: { busy?: boolean } = {}): string {
  const connection = !vm.configured ? StatusPill("off", "Not configured") : vm.connected ? StatusPill("ok", "Connected") : StatusPill("error", "Not connected");
  const ai = vm.ai;
  const tiles = TileRow([
    StatTile({ label: "Connection", value: connection, sub: !vm.configured ? "add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET" : vm.connected ? "read-only" : h`<a href="/gmail/login">Log in to Gmail</a>` }),
    StatTile({ label: "Mode", value: vm.dryRun ? StatusPill("dry") : StatusPill("live"), sub: vm.dryRun ? "logs what it would add" : "adds expenses" }),
    StatTile({ label: "Schedule", value: vm.scheduleText, sub: `looks back ${plural(vm.lookbackDays, "day")}` }),
    StatTile({ label: "AI spend", value: usd(ai.spendUsd), sub: `of ${usd(ai.capUsd, 0)} this month (all features)`, state: ai.fraction >= 1 ? "error" : ai.fraction >= 0.8 ? "warn" : "ok" }),
    StatTile({ label: "AI calls today", value: `${ai.callsToday} / ${ai.callCap}`, sub: vm.aiConfigured ? "daily cap" : "AI_GATEWAY_API_KEY is not set", state: !vm.aiConfigured ? "error" : ai.callsToday >= ai.callCap ? "error" : "ok" }),
  ]);

  const l = vm.lastRun;
  const a = vm.allTime;
  const compare = DataTable({
    caption: l ? `Last run (${l.dryRun ? "dry run" : "live"}, ${l.status}) and all time` : "Last run and all time",
    sortable: false,
    columns: [{ label: "" , hideLabel: true }, { label: "Last run", align: "right" }, { label: "All time", align: "right" }],
    rows: [
      { cells: ["Emails checked", h`<span class="num">${l ? l.checked : "—"}</span>`, h`<span class="num">${a.checked}</span>`] },
      { cells: ["Invoices found", h`<span class="num">${l ? l.invoices : "—"}</span>`, h`<span class="num">${a.invoices}</span>`] },
      { cells: [vm.dryRun ? "Would add" : "Added", h`<span class="num">${l ? l.added : "—"}</span>`, h`<span class="num">${a.added}</span>`] },
      { cells: ["Merged with a tap", h`<span class="num">${l ? l.merges : "—"}</span>`, h`<span class="num">${a.merged}</span>`] },
      { cells: ["Errors", h`<span class="num">${l ? l.errors : "—"}</span>`, h`<span class="num">${a.errors}</span>`] },
    ],
    empty: EmptyState("No run yet"),
  });

  const aiCard = Card({
    title: "AI usage this month",
    body: ai.byFeature.length
      ? h`<ul class="bars">${ai.byFeature.map((f) => h`<li><span class="bar-label">${f.label}</span><span></span><span class="bar-value num">${usd(f.costUsd, 4)} · ${f.calls}</span></li>`)}</ul>${ai.untaggedUsd > 0.00005 ? h`<p class="note">Earlier or untagged: ${usd(ai.untaggedUsd, 4)}</p>` : ""}`
      : h`<p class="note">Total ${usd(ai.spendUsd, 4)} (estimate). A per-feature breakdown appears as new calls are made.</p>`,
  });

  const filters = [
    { value: "", label: "All" },
    { value: "invoice", label: "Invoice" },
    { value: "not_invoice", label: "Not invoice" },
    { value: "error", label: "Error" },
  ];
  const tabs = h`<div class="row-actions" role="group" aria-label="Filter by result">${filters.map((f) => h`<a class="btn ${(vm.filter ?? "") === f.value ? "" : "btn-quiet"}" href="/gmail${f.value ? `?result=${f.value}` : ""}"${raw((vm.filter ?? "") === f.value ? ` aria-current="true"` : "")}>${f.label}</a>`)}</div>`;

  const table = DataTable({
    caption: "Processed emails",
    id: "emails",
    columns: [{ label: "Message", sort: "text" }, { label: "Processed", sort: "num" }, { label: "Result" }, { label: "Detail" }],
    rows: vm.emails.map((e) => ({
      cells: [
        { html: h`<a class="mono" href="https://mail.google.com/mail/u/0/#all/${encodeURIComponent(e.messageId)}" target="_blank" rel="noreferrer" title="${e.messageId}">${shortId(e.messageId, 12)}</a>`, sort: e.messageId },
        { html: Moment(e.processedAt), sort: e.processedAt.getTime() },
        resultPill(e.result, e.dryRun),
        h`${e.detail || h`<span class="muted">—</span>`}`,
      ],
    })),
    empty: EmptyState(vm.filter ? "Nothing with that result" : "Nothing processed yet", "Only the message id and what we decided are kept, never the email text."),
  });

  const notes = [
    vm.lastRun?.aiBlocked ? Banner("error", "AI stopped", [{ text: `${vm.lastRun.aiBlocked}. No emails are being read until it resets.` }]) : "",
    vm.lastRun?.status === "failure" ? Banner("error", "The last Gmail run failed", [{ text: vm.lastRun.lastError ?? "unknown error" }]) : "",
    vm.lastRun && vm.lastRun.status === "success" && vm.lastRun.errors > 0 ? Banner("warn", `${plural(vm.lastRun.errors, "email")} could not be used in the last run`, [{ text: "Bad model output or failed checks." }]) : "",
    opts.busy ? Banner("info", "The job is already running. Try again in a moment.") : "",
  ];
  const run = vm.run
    ? Card({
        id: "output",
        title: `Output of run #${vm.run.id}`,
        pill: vm.run.status === "success" ? StatusPill("ok") : vm.run.status === "running" ? StatusPill("info", "Running") : StatusPill("error", "Failing"),
        body: h`<p class="note"><time datetime="${vm.run.startedAt.toISOString()}" title="${dateTimeFull(vm.run.startedAt)}">Started ${RelativeTime(vm.run.startedAt, now)}</time> · ${duration(vm.run.durationMs)}</p><pre>${vm.run.log || "(no output)"}</pre>`,
      })
    : Card({ id: "output", title: "Output", body: EmptyState("No runs yet", 'Press "Run now".') });

  const body = h`${notes}
${tiles}
<div class="split">${compare}${aiCard}</div>
<form class="row-actions" method="post" action="/gmail/run"><button class="btn" type="submit">Run now</button></form>
${run}
${Section("Processed emails", h`${tabs}${table}`, vm.emails.length)}`;
  return PageLayout({ title: "Invoices", active: "invoices", body, now });
}

