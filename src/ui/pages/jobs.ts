import { Banner, DataTable, EmptyState, PageLayout, RelativeTime, Section, StatusPill } from "../components";
import { dateTimeFull, duration } from "../format";
import { h } from "../html";
import type { JobVM, RunVM } from "../vm/types";
import { runPill } from "./shared";

// Jobs: every job with its schedule in plain words and an OVERDUE flag, then the run history (failures first).

function jobTable(jobs: JobVM[], now: Date, caption: string, retired = false) {
  return DataTable({
    caption,
    id: retired ? "retired" : "jobs",
    columns: [
      { label: "Name", sort: "text" },
      { label: "Schedule" },
      { label: "Enabled" },
      { label: "Last run", sort: "num" },
      { label: "Last status" },
      { label: "Duration", align: "right" },
      { label: "Next run", sort: "num" },
      { label: "Flag" },
    ],
    rows: jobs.map((j) => ({
      className: j.overdue ? "row-warn" : j.lastStatus === "failure" ? "row-error" : undefined,
      cells: [
        { html: h`<a href="/jobs?job=${encodeURIComponent(j.name)}#history"><strong>${j.name}</strong></a>`, sort: j.name },
        h`<span title="${`cron: ${j.cron}`}">${j.scheduleHuman}</span>`,
        { html: j.enabled ? StatusPill("ok", "Enabled") : StatusPill("off", "Disabled"), mobileHide: j.enabled },
        { html: RelativeTime(j.lastRunAt, now, "never"), sort: j.lastRunAt?.getTime() ?? 0 },
        retired ? StatusPill("off", "Retired") : runPill(j.lastStatus, j.quiet),
        { html: h`<span class="num">${duration(j.lastDurationMs)}</span>`, mobileHide: j.lastDurationMs === null },
        { html: retired ? h`<span class="muted">not scheduled</span>` : RelativeTime(j.nextRunAt, now, "—"), sort: j.nextRunAt?.getTime() ?? 0 },
        { html: j.overdue ? StatusPill("warn", "Overdue") : j.waiting ? StatusPill("info", "Waiting for first run") : h`<span class="muted">—</span>`, mobileHide: !j.overdue && !j.waiting },
      ],
    })),
    empty: EmptyState("No jobs registered"),
  });
}

function runTable(runs: RunVM[], now: Date, caption: string) {
  return DataTable({
    caption,
    id: "runs",
    columns: [{ label: "#", sort: "num" }, { label: "Job", sort: "text" }, { label: "Started", sort: "num" }, { label: "Status" }, { label: "Duration", align: "right" }],
    rows: runs.map((r) => ({
      className: r.status === "failure" ? "row-error" : undefined,
      detail: r.log ? h`<pre>${r.log}</pre>` : undefined,
      cells: [
        { html: h`<span class="num">${r.id}</span>`, sort: r.id },
        { html: h`<a href="/jobs?job=${encodeURIComponent(r.job)}#history">${r.job}</a>`, sort: r.job },
        { html: h`<time datetime="${r.startedAt.toISOString()}" title="${dateTimeFull(r.startedAt)}">${RelativeTime(r.startedAt, now)}</time>`, sort: r.startedAt.getTime() },
        r.status === "success" ? StatusPill("ok") : r.status === "running" ? StatusPill("info", "Running") : StatusPill("error", "Failing"),
        h`<span class="num">${duration(r.durationMs)}</span>`,
      ],
    })),
    empty: EmptyState("No runs to show", "Successful runs that had nothing to report are not recorded."),
  });
}

export function jobsPage(opts: { jobs: JobVM[]; runs: RunVM[]; hiddenNoisy: number; job: string | null; all: boolean }, now: Date): string {
  const active = opts.jobs.filter((j) => !j.retired);
  const retired = opts.jobs.filter((j) => j.retired);
  const overdue = active.filter((j) => j.overdue && j.enabled);
  const banner = overdue.length
    ? Banner("warn", `${overdue.length} job${overdue.length === 1 ? " is" : "s are"} overdue`, overdue.map((j) => ({ text: j.overdueReason ?? "", label: j.name, link: `/jobs?job=${encodeURIComponent(j.name)}#history` })))
    : "";
  const caption = opts.job ? `Run history for ${opts.job}` : opts.all ? "All recent runs" : "Latest runs (failures first)";
  const toggle = opts.job
    ? h`<a class="btn btn-quiet" href="/jobs#history">Back to all jobs</a>`
    : opts.all
      ? h`<a class="btn btn-quiet" href="/jobs#history">Hide routine runs</a>`
      : h`<a class="btn btn-quiet" href="/jobs?all=1#history">Show all (${opts.hiddenNoisy} routine runs hidden)</a>`;

  const body = h`${banner}
${Section("Jobs", jobTable(active, now, "Scheduled jobs"), active.length)}
${retired.length ? h`<details class="fold"><summary>Retired jobs (${retired.length})</summary><p class="note">These are in the database but this server no longer schedules them (the job was renamed or removed), so they are not checked for being overdue.</p>${jobTable(retired, now, "Retired jobs", true)}</details>` : ""}
<div id="history">${Section("Run history", h`<div class="row-actions">${toggle}</div>${runTable(opts.runs, now, caption)}`)}</div>`;
  return PageLayout({ title: "Jobs", active: "jobs", body, now });
}

