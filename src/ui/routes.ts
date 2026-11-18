import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { dashboardAccess } from "../access";
import { ROOT } from "../config";
import { settings } from "../settings";
import { jobSchedules } from "../runner";
import { checkCron } from "../settings/cron";
import { liveContext } from "./context";
import { homeSettingsPage } from "./pages/home-settings";
import { appendToPage, flashFrom, JobSchedulesPanel, sameSite, saveGroup, SettingsPanel } from "./settings";
import { GROUPS, type Group } from "../settings";
import { expensesPage } from "./pages/expenses";
import { jobsPage } from "./pages/jobs";
import { overviewPage } from "./pages/overview";
import { voicePage } from "./pages/voice";
import { buildExpenses, type ExpenseFilter } from "./vm/expenses";
import { buildJobs, buildRuns } from "./vm/jobs";
import { buildOverview } from "./vm/overview";
import { buildVoice } from "./vm/voice";
import type { ExpenseSource, SheetStatus } from "./vm/types";

// The dashboard pages that are not part of a module: Overview, Expenses, Jobs, and the two static files.
// Every route sits behind dashboardAccess (this Mac, or the Cloudflare Access tunnel), like the other dashboards.

export const uiRoutes = new Hono();

uiRoutes.get("/", dashboardAccess, (c) => {
  const ctx = liveContext();
  return c.html(appendToPage(overviewPage(buildOverview(ctx), ctx.now), SettingsPanel({ group: "ai", back: "/", flash: flashFrom(c.req.query()) })));
});

// Calls: the voice assistant's spend, calls and tools (summaries only).
uiRoutes.get("/calls", dashboardAccess, (c) => {
  const ctx = liveContext();
  const flags = ctx.flags.voice ?? { enabled: false, configured: false, writesLive: false, phraseSet: false, capUsd: 10 };
  return c.html(appendToPage(voicePage(buildVoice(ctx.db, ctx.now, flags), ctx.now), SettingsPanel({ group: "voice", back: "/calls", flash: flashFrom(c.req.query()) })));
});

const SOURCES = ["tap", "email", "bank", "manual"];
const SHEETS = ["synced", "pending", "failed", "duplicate", "unreadable"];

export function expenseFilterFromQuery(q: Record<string, string | undefined>): ExpenseFilter {
  return {
    month: q.month && /^\d{4}-\d{2}$/.test(q.month) ? q.month : undefined,
    source: SOURCES.includes(q.source ?? "") ? (q.source as ExpenseSource) : undefined,
    category: q.category ? q.category.slice(0, 60) : undefined,
    sheet: SHEETS.includes(q.sheet ?? "") ? (q.sheet as SheetStatus) : undefined,
    q: q.q ? q.q.slice(0, 80) : undefined,
    showTests: q.tests === "1",
  };
}

uiRoutes.get("/expenses", dashboardAccess, (c) => {
  const ctx = liveContext();
  const filter = expenseFilterFromQuery(c.req.query());
  const vm = buildExpenses(ctx.db, filter, ctx.now, ctx.flags.sheetConfigured);
  return c.html(expensesPage(vm, filter, ctx.now));
});

uiRoutes.get("/jobs", dashboardAccess, (c) => {
  const ctx = liveContext();
  const jobs = buildJobs(ctx.db, ctx.registered, ctx.now);
  const job = c.req.query("job");
  const known = job && jobs.some((j) => j.name === job) ? job : null;
  const all = c.req.query("all") === "1";
  const { runs, hiddenNoisy } = buildRuns(ctx.db, { job: known ?? undefined, all });
  return c.html(appendToPage(jobsPage({ jobs, runs, hiddenNoisy, job: known, all }, ctx.now), JobSchedulesPanel({ jobs: jobSchedules(), back: "/jobs", flash: flashFrom(c.req.query()) })));
});

// ---- Home Assistant: the garage, who triggers what, the lights voice may switch
uiRoutes.get("/home-assistant", dashboardAccess, (c) => {
  const ctx = liveContext();
  return c.html(homeSettingsPage(ctx.now, flashFrom(c.req.query())));
});

// ---- Saving a settings panel (a plain form post; the page it came from is shown again)
const backTo = (back: string | null) => (back && /^\/[a-z-]*$/.test(back) ? back : "/");
const redirectWith = (back: string, q: string) => `${back}?${q}#settings`;

uiRoutes.post("/settings/save", dashboardAccess, async (c) => {
  if (!sameSite({ origin: c.req.header("origin"), host: c.req.header("host"), secFetchSite: c.req.header("sec-fetch-site") })) return c.text("Forbidden", 403);
  const form = new URLSearchParams(await c.req.text());
  const back = backTo(form.get("back"));
  const group = form.get("group") ?? "";

  if (group === "jobs") {
    let saved = 0;
    const errors: string[] = [];
    for (const job of jobSchedules()) {
      const typed = form.get(`cron.${job.name}`);
      if (typed === null || typed.trim() === job.expression) continue;
      const text = typed.trim();
      if (text !== "" && text !== job.defaultExpression) {
        const problem = checkCron(text);
        if (problem) {
          errors.push(`${job.name}: ${problem}`);
          continue;
        }
        settings.write(`jobs.cron.${job.name}`, text);
      } else settings.reset(`jobs.cron.${job.name}`);
      saved++;
    }
    return c.redirect(redirectWith(back, errors.length ? `err=${encodeURIComponent(errors.join("; "))}` : `saved=${saved}`), 303);
  }

  if (!(group in GROUPS)) return c.text("Unknown settings group", 400);
  const { saved, errors } = saveGroup(group as Group, form);
  return c.redirect(redirectWith(back, errors.length ? `err=${encodeURIComponent(errors.join("; "))}` : `saved=${saved}`), 303);
});

// ---- Static files: only these two, read from /public, never anything else.
const ASSETS: Record<string, string> = { "dashboard.css": "text/css; charset=utf-8", "dashboard.js": "text/javascript; charset=utf-8" };

uiRoutes.get("/assets/:file", dashboardAccess, (c) => {
  const name = c.req.param("file");
  const type = ASSETS[name];
  if (!type) return c.text("Not found", 404);
  const file = path.join(ROOT, "public", name);
  if (!fs.existsSync(file)) return c.text("Not found", 404);
  c.header("Content-Type", type);
  c.header("Cache-Control", "private, max-age=3600"); // the page links ?v=<version>, so a change is picked up
  return c.body(fs.readFileSync(file, "utf8"));
});

