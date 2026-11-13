import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { dashboardAccess } from "../access";
import { ROOT } from "../config";
import { liveContext } from "./context";
import { expensesPage } from "./pages/expenses";
import { jobsPage } from "./pages/jobs";
import { overviewPage } from "./pages/overview";
import { buildExpenses, type ExpenseFilter } from "./vm/expenses";
import { buildJobs, buildRuns } from "./vm/jobs";
import { buildOverview } from "./vm/overview";
import type { ExpenseSource, SheetStatus } from "./vm/types";

// The dashboard pages that are not part of a module: Overview, Expenses, Jobs, and the two static files.
// Every route sits behind dashboardAccess (this Mac, or the Cloudflare Access tunnel), like the other dashboards.

export const uiRoutes = new Hono();

uiRoutes.get("/", dashboardAccess, (c) => {
  const ctx = liveContext();
  return c.html(overviewPage(buildOverview(ctx), ctx.now));
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
  return c.html(jobsPage({ jobs, runs, hiddenNoisy, job: known, all }, ctx.now));
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

