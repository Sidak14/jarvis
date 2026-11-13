import { aiCapReason } from "../../ai/usage";
import { AI_WARN_FRACTION, JOB_FAILURE_STREAK } from "../../telegram/settings";
import { getState as tgState } from "../../telegram/state";
import { ago } from "../../telegram/format";
import { money, plural, usd } from "../format";
import { buildAiUsage } from "./ai";
import { buildExpenses, type ExpensesVM } from "./expenses";
import { buildGmail, type GmailVM } from "./gmail";
import { buildJobs, lastOkAt } from "./jobs";
import { buildPlans, type PlansVM } from "./plans";
import { buildSpotify, type SpotifyVM } from "./spotify";
import type { Fact, Issue, JobVM, ModuleStatus, OverviewVM, State, StatTileVM, UiContext } from "./types";

// The Overview: one ModuleStatus per module, the health banner, and the stat tiles. Each module's state comes from
// the same facts the old status page showed, so nothing is lost: the facts are kept on the card under "Details".

const order: Record<State, number> = { ok: 0, off: 0, warn: 1, error: 2 };
const worst = (...states: State[]): State => states.reduce((a, b) => (order[b] > order[a] ? b : a), "ok" as State);

interface Parts {
  jobs: JobVM[];
  expenses: ExpensesVM;
  gmail: GmailVM;
  spotify: SpotifyVM;
  plans: PlansVM;
}

export function expensesModule(ctx: UiContext, p: Parts): ModuleStatus {
  const e = p.expenses;
  const issues = e.notes.map((n) => n.text);
  const state: State = e.notes.length ? "error" : e.tiles.pendingSync > 0 ? "warn" : "ok";
  const sheetIssues = e.tiles.pendingSync > 0 && !e.notes.length ? [`${plural(e.tiles.pendingSync, "expense")} not in the Sheet yet`] : [];
  return {
    key: "expenses",
    name: "Expenses",
    state,
    summary: e.tiles.count ? `${money(e.tiles.totalCents)} this month · ${plural(e.tiles.count, "expense")}` : "Nothing spent this month yet",
    lastOkAt: lastOkAt(p.jobs, "expenses-sync"),
    link: "/expenses",
    issues: [...issues, ...sheetIssues],
    facts: [
      { label: "Not in the Sheet yet", value: String(e.tiles.pendingSync) },
      { label: "Unreadable", value: String(e.tiles.unreadable) },
      { label: "Uncategorised (this month)", value: String(e.tiles.uncategorised) },
      { label: "Google Sheet", value: ctx.flags.sheetConfigured ? "configured" : "not configured" },
    ],
  };
}

export function gmailModule(ctx: UiContext, p: Parts): ModuleStatus {
  const g = p.gmail;
  const capReason = aiCapReason(ctx.db, ctx.now);
  const issues: string[] = [];
  let state: State = "ok";
  if (!g.configured) state = "off";
  else if (!g.connected) {
    state = "error";
    issues.push("Gmail is not connected: log in again");
  }
  if (capReason) {
    state = "error";
    issues.push(`AI stopped: ${capReason}`);
  }
  if (g.lastRun?.status === "failure") {
    state = "error";
    issues.push(`Last Gmail run failed: ${g.lastRun.lastError ?? "unknown error"}`);
  } else if (g.lastRun && g.lastRun.errors > 0) {
    state = worst(state, "warn");
    issues.push(`${plural(g.lastRun.errors, "email")} could not be used in the last run`);
  }
  return {
    key: "gmail",
    name: "Gmail invoices",
    state,
    mode: g.dryRun ? "dry" : "live",
    summary: g.lastRun ? `${plural(g.lastRun.checked, "email")} checked · ${g.lastRun.invoices} invoice${g.lastRun.invoices === 1 ? "" : "s"} found last run` : "No run yet",
    lastOkAt: lastOkAt(p.jobs, "gmail-expenses"),
    link: "/gmail",
    issues,
    facts: [
      { label: "Connection", value: !g.configured ? "not configured" : g.connected ? "connected (read-only)" : "not connected" },
      { label: "Schedule", value: `${g.scheduleText}, last ${g.lookbackDays} days` },
      { label: "All time", value: `${g.allTime.invoices} invoice · ${g.allTime.notInvoice} not invoice · ${g.allTime.errors} error` },
    ],
  };
}

export function spotifyModule(_ctx: UiContext, p: Parts): ModuleStatus {
  const s = p.spotify;
  const job = p.jobs.find((j) => j.name === "spotify-likes");
  const issues: string[] = [];
  let state: State = "ok";
  if (!s.configured) state = "off";
  else if (!s.connected) {
    state = "error";
    issues.push("Spotify is not connected: log in again");
  }
  if (job && job.lastStatus === "failure") {
    state = worst(state, job.consecutiveFailures >= JOB_FAILURE_STREAK ? "error" : "warn");
    issues.push("The last Spotify run failed");
  }
  return {
    key: "spotify",
    name: "Spotify",
    state,
    mode: s.dryRun ? "dry" : "live",
    summary: `${plural(s.likesThisWeek, "song")} liked this week · rule: ${s.ruleText}`,
    lastOkAt: lastOkAt(p.jobs, "spotify-likes"),
    link: "/spotify",
    issues,
    facts: [
      { label: "Connection", value: !s.configured ? "not configured" : s.connected ? "connected" : "not connected" },
      { label: "Schedule", value: s.scheduleText },
      { label: "API calls today", value: String(s.apiCallsToday) },
    ],
  };
}

export function telegramModule(ctx: UiContext, p: Parts): ModuleStatus {
  const { db, now, flags } = ctx;
  const pollOk = tgState(db, "last_poll_ok_at");
  const pollError = tgState(db, "last_poll_error");
  const outbox = db
    .prepare(`SELECT COALESCE(SUM(status = 'pending'), 0) AS pending, COALESCE(SUM(status = 'failed'), 0) AS failed, MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest FROM outbox`)
    .get() as { pending: number; failed: number; oldest: string | null };
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
  const asked = count(`SELECT COUNT(*) AS n FROM expenses WHERE asked_at >= ?`, weekAgo);
  const answered = count(`SELECT COUNT(*) AS n FROM expenses WHERE answered_at >= ?`, weekAgo);
  const bySource = (source: string) => count(`SELECT COUNT(*) AS n FROM expenses WHERE category_source = ? AND received_at >= ?`, source, weekAgo);
  const lastError = tgState(db, "last_send_error");

  const issues: string[] = [];
  let state: State = "ok";
  let connection: string;
  if (!flags.telegramConfigured) {
    state = "off";
    connection = "not configured";
  } else if (!flags.telegramOwnerSet) {
    state = "warn";
    connection = "waiting for TELEGRAM_OWNER_ID";
    issues.push("Telegram is waiting for TELEGRAM_OWNER_ID: message /start to the bot");
  } else if (pollError) {
    state = "error";
    connection = `not connected: ${pollError}`;
    issues.push(`Telegram is not connected: ${pollError}`);
  } else if (pollOk && now.getTime() - Date.parse(pollOk) < 120_000) {
    connection = `connected${tgState(db, "bot_username") ? ` as @${tgState(db, "bot_username")}` : ""}`;
  } else {
    connection = "starting";
  }
  if (outbox.failed > 0) {
    state = worst(state, "error");
    issues.push(`${plural(outbox.failed, "Telegram message")} failed to send${lastError ? `: ${lastError}` : ""}`);
  } else if (outbox.pending > 0 && outbox.oldest && now.getTime() - Date.parse(outbox.oldest) > 15 * 60_000) {
    state = worst(state, "warn");
    issues.push(`${plural(outbox.pending, "Telegram message")} waiting (oldest ${ago(outbox.oldest, now)})`);
  }
  return {
    key: "telegram",
    name: "Telegram",
    state,
    summary: `Bot ${connection} · ${asked} asked, ${answered} answered this week`,
    lastOkAt: pollOk ? new Date(pollOk) : null,
    link: "/#telegram",
    issues,
    facts: [
      { label: "Last message received", value: ago(tgState(db, "last_received_at"), now) },
      { label: "Last message sent", value: ago(tgState(db, "last_sent_at"), now) },
      { label: "Outbox", value: `${outbox.pending} pending${outbox.pending && outbox.oldest ? ` (oldest ${ago(outbox.oldest, now)})` : ""}, ${outbox.failed} failed` },
      { label: "Expense questions", value: flags.telegramQuestions ? "on (non-urgent messages wait for 9am to 11pm Sydney)" : "off (TELEGRAM_QUESTIONS_ENABLED)" },
      { label: "Categories this week", value: `${bySource("ai")} by AI · ${bySource("history")} by repeat merchant · ${bySource("owner")} by you` },
      { label: "Uncategorised in total", value: String(p.expenses.tiles.uncategorised) },
    ],
  };
}

export function beeperModule(ctx: UiContext, p: Parts): ModuleStatus {
  const b = p.plans.status.beeper;
  const issues: string[] = [];
  let state: State = "ok";
  let line: string;
  if (!b.configured) {
    state = "off";
    line = "Not configured (set BEEPER_ACCESS_TOKEN)";
  } else if (b.error) {
    state = "error";
    line = "Not connected";
    issues.push(`Beeper is not connected: ${b.error}`);
  } else if (b.lastPollAt) {
    line = `Connected · ${b.accounts ?? "?"} accounts · reading ${p.plans.status.scope}`;
  } else {
    line = "Starting";
  }
  return {
    key: "beeper",
    name: "Beeper",
    state,
    summary: line,
    lastOkAt: b.lastPollAt,
    link: "/plans",
    issues,
    facts: [
      { label: "Server", value: b.baseUrl },
      { label: "Chats read", value: p.plans.status.scope },
    ],
  };
}

export function plansModule(ctx: UiContext, p: Parts): ModuleStatus {
  const s = p.plans.status;
  const issues: string[] = [];
  let state: State = ctx.flags.beeperConfigured ? "ok" : "off";
  const job = p.jobs.find((j) => j.name === "plans-poll");
  if (state !== "off") {
    if (s.runError) {
      state = worst(state, job && job.consecutiveFailures >= JOB_FAILURE_STREAK ? "error" : "warn");
      issues.push(`Plans: ${s.runError}`);
    }
    if (!s.dryRun && !s.calendarConnected) {
      state = worst(state, "warn");
      issues.push("Google Calendar is not connected, so confirmed plans can not be added");
    }
  }
  return {
    key: "plans",
    name: "Plans",
    state,
    mode: s.dryRun ? "dry" : "live",
    summary: `${p.plans.needs.length} need my attention · ${p.plans.upcoming.length} upcoming`,
    lastOkAt: lastOkAt(p.jobs, "plans-poll"),
    link: "/plans",
    issues,
    facts: [
      { label: "Found this week", value: String(s.foundThisWeek) },
      { label: "Messages waiting", value: String(s.messagesWaiting) },
      { label: "Last batch", value: s.lastBatchSummary ? `${s.lastBatchSummary}${s.lastBatchAt ? ` (${ago(s.lastBatchAt.toISOString(), ctx.now)})` : ""}` : "none yet" },
      { label: "Calendar", value: s.calendarConnected ? "connected" : "not connected" },
    ],
  };
}

/** Which jobs deserve a place in the health banner. Retired jobs (no longer scheduled) are ignored. */
export function jobIssues(jobs: JobVM[]): Issue[] {
  const out: Issue[] = [];
  for (const j of jobs) {
    if (j.retired || !j.enabled) continue;
    if (j.overdue) out.push({ module: "Jobs", text: `${j.name} is overdue: ${j.overdueReason ?? "it has stopped running"}`, severity: "warn", link: `/jobs?job=${encodeURIComponent(j.name)}` });
    if (j.lastStatus === "failure") {
      out.push({ module: "Jobs", text: `${j.name} failed${j.consecutiveFailures > 1 ? ` ${j.consecutiveFailures} times in a row` : ""}`, severity: j.consecutiveFailures >= JOB_FAILURE_STREAK ? "error" : "warn", link: `/jobs?job=${encodeURIComponent(j.name)}` });
    }
  }
  return out;
}

export function buildOverview(ctx: UiContext): OverviewVM & { jobs: JobVM[]; ai: ReturnType<typeof buildAiUsage> } {
  const { db, now } = ctx;
  const jobs = buildJobs(db, ctx.registered, now);
  const parts: Parts = {
    jobs,
    expenses: buildExpenses(db, {}, now, ctx.flags.sheetConfigured),
    gmail: buildGmail(ctx),
    spotify: buildSpotify(ctx),
    plans: buildPlans(ctx),
  };
  const modules = [expensesModule(ctx, parts), gmailModule(ctx, parts), spotifyModule(ctx, parts), telegramModule(ctx, parts), plansModule(ctx, parts), beeperModule(ctx, parts)];

  const ai = buildAiUsage(db, now);
  const items: Issue[] = [];
  for (const m of modules) for (const text of m.issues) items.push({ module: m.name, text, severity: m.state === "error" ? "error" : "warn", link: m.link });
  items.push(...jobIssues(jobs));
  if (ai.fraction >= 1) items.push({ module: "AI", text: `AI spend cap reached (${usd(ai.spendUsd)} of ${usd(ai.capUsd, 0)})`, severity: "error", link: "/gmail" });
  else if (ai.fraction >= AI_WARN_FRACTION) items.push({ module: "AI", text: `AI spend is at ${Math.round(ai.fraction * 100)}% of the monthly cap`, severity: "warn", link: "/gmail" });

  const health = { state: items.some((i) => i.severity === "error") ? ("error" as const) : items.length ? ("warn" as const) : ("ok" as const), items };
  const jobProblems = jobs.filter((j) => !j.retired && j.enabled && (j.overdue || j.lastStatus === "failure")).length;
  const e = parts.expenses.tiles;
  const tiles: StatTileVM[] = [
    { label: "Spent this month", value: money(e.totalCents), sub: `${plural(e.count, "expense")} · ${e.uncategorised} uncategorised`, href: "/expenses" },
    { label: "Not yet in the Sheet", value: String(e.pendingSync), sub: e.unreadable ? `${e.unreadable} unreadable` : "waiting to sync", state: e.pendingSync || e.unreadable ? "warn" : "ok", href: "/expenses" },
    { label: "Songs liked this week", value: String(parts.spotify.likesThisWeek), sub: parts.spotify.dryRun ? "dry run" : "by Jarvis", href: "/spotify" },
    { label: "Plans needing me", value: String(parts.plans.needs.length), sub: `${parts.plans.upcoming.length} upcoming`, state: parts.plans.needs.length ? "warn" : "ok", href: "/plans" },
    { label: "AI spend this month", value: usd(ai.spendUsd), sub: `of ${usd(ai.capUsd, 0)} · ${ai.callsToday}/${ai.callCap} calls today`, state: ai.fraction >= 1 ? "error" : ai.fraction >= AI_WARN_FRACTION ? "warn" : "ok", href: "/#ai" },
    { label: "Jobs failing or overdue", value: String(jobProblems), sub: jobProblems ? "see the Jobs page" : "all on schedule", state: jobProblems ? "warn" : "ok", href: "/jobs" },
  ];
  return { health, tiles, modules, jobs, ai };
}

