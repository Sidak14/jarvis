import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { addStance, insertPlan, updatePlan } from "../plans/store";
import { createAllTables } from "../schema";
import { Banner, DataTable, PageLayout, StatusPill } from "./components";
import { clock, dateTime, dateTimeFull, dayAndTime, duration, money, monthKeyOf, monthLabel, plural, relativeTime, scheduleToWords, shortId, usd } from "./format";
import { h, raw } from "./html";
import { expensesPage } from "./pages/expenses";
import { invoicesPage } from "./pages/invoices";
import { jobsPage } from "./pages/jobs";
import { overviewPage } from "./pages/overview";
import { plansPage } from "./pages/plans";
import { spotifyPage } from "./pages/spotify";
import { buildAiUsage } from "./vm/ai";
import { buildExpenses, isTestMerchant } from "./vm/expenses";
import { buildGmail } from "./vm/gmail";
import { buildJobs, buildRuns, overdueState } from "./vm/jobs";
import { buildOverview } from "./vm/overview";
import { buildPlans } from "./vm/plans";
import { buildSpotify } from "./vm/spotify";
import type { RegisteredJob, UiContext, UiFlags } from "./vm/types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date("2026-11-13T02:00:00Z"); // Fri 13 Nov 2026, 1:00 pm in Sydney (AEDT, UTC+11)
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (ms: number) => iso(NOW.getTime() - ms);
const ahead = (ms: number) => iso(NOW.getTime() + ms);

const FLAGS: UiFlags = {
  sheetConfigured: true, gmailConfigured: true, gmailConnected: true, gmailDryRun: false, spotifyConfigured: true, spotifyConnected: true, spotifyDryRun: false,
  telegramConfigured: true, telegramOwnerSet: true, telegramQuestions: true, beeperConfigured: true, beeperBaseUrl: "http://127.0.0.1:23373", plansDryRun: false,
  plansAllChats: true, calendarConnected: true, aiConfigured: true,
};
const reg = (name: string, cron: string, minutes: number, timezone: string | null = null): RegisteredJob => ({ name, cron, timezone, intervalMs: minutes * MIN });
const REGISTERED = [reg("heartbeat", "*/5 * * * *", 5), reg("expenses-sync", "*/15 * * * *", 15), reg("gmail-expenses", "0 * * * *", 60), reg("spotify-likes", "0 */2 * * *", 120), reg("plans-poll", "*/5 * * * *", 5), reg("telegram-outbox", "* * * * *", 1), reg("expenses-categorise", "0 21 * * *", 1440, "Australia/Sydney")];

function ctx(over: { flags?: Partial<UiFlags>; registered?: RegisteredJob[]; now?: Date } = {}): UiContext {
  const db = new Database(":memory:");
  createAllTables(db);
  return { db, now: over.now ?? NOW, flags: { ...FLAGS, ...over.flags }, registered: over.registered ?? REGISTERED };
}

function addJob(c: UiContext, name: string, schedule: string, o: { last?: string | null; next?: string | null; enabled?: number; failures?: number } = {}) {
  c.db.prepare(`INSERT INTO jobs (name, schedule, enabled, last_run_at, next_run_at, consecutive_failures) VALUES (?, ?, ?, ?, ?, ?)`).run(name, schedule, o.enabled ?? 1, o.last ?? null, o.next ?? null, o.failures ?? 0);
}
function addRun(c: UiContext, job: string, status: "success" | "failure" | "running", startedAt: string, o: { ms?: number; log?: string } = {}) {
  c.db.prepare(`INSERT INTO runs (job, started_at, finished_at, status, duration_ms, log) VALUES (?, ?, ?, ?, ?, ?)`).run(job, startedAt, startedAt, status, o.ms ?? 5, o.log ?? null);
}
let n = 0;
function addExpense(c: UiContext, o: { merchant?: string | null; cents?: number | null; currency?: string; at?: string; received?: string; status?: string; source?: string; category?: string | null; error?: string | null; parse?: string; card?: string | null; email?: string | null } = {}) {
  c.db
    .prepare(
      `INSERT INTO expenses (merchant, amount_cents, currency, card, occurred_at, received_at, sheet_status, raw_payload, parse_status, source, category, last_error, email_message_id, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?)`,
    )
    .run(o.merchant === undefined ? `Shop ${++n}` : o.merchant, o.cents === undefined ? 1000 : o.cents, o.currency ?? "AUD", o.card ?? "Visa", o.at ?? ago(2 * HOUR), o.received ?? ago(HOUR), o.status ?? "synced", o.parse ?? "ok", o.source ?? "tap", o.category ?? null, o.error ?? null, o.email ?? null, o.error ? 3 : 0);
}

// ---------------------------------------------------------------- formatting

describe("formatting", () => {
  it("money: dollars as $17.70, other currencies labelled, thousands separated, missing as a dash", () => {
    assert.equal(money(1770), "$17.70");
    assert.equal(money(5), "$0.05");
    assert.equal(money(123_450), "$1,234.50");
    assert.equal(money(1117, "USD"), "11.17 USD");
    assert.equal(money(-250), "-$2.50");
    assert.equal(money(null), "—");
    assert.equal(usd(0.0159, 4), "$0.0159");
  });
  it("times are Sydney time, including across daylight saving", () => {
    assert.equal(dateTime(new Date("2026-11-13T02:27:00Z")), "Fri 13 Nov 2026, 1:27 pm"); // AEDT
    assert.equal(dateTime(new Date("2026-07-19T02:27:00Z")), "Sun 19 Jul 2026, 12:27 pm"); // AEST
    assert.equal(clock(new Date("2026-11-12T13:05:00Z")), "12:05 am");
    assert.equal(clock(new Date("2026-11-13T01:00:00Z")), "12:00 pm");
    assert.match(dateTimeFull(new Date("2026-11-13T02:27:24Z")), /^Fri 13 Nov 2026, 1:27:24 pm AEDT$/);
    assert.equal(monthKeyOf(new Date("2026-10-31T13:30:00Z")), "2026-11", "1:30am on 1 November in Sydney is November");
    assert.equal(monthKeyOf(new Date("2026-10-31T12:30:00Z")), "2026-10");
    assert.equal(monthLabel("2026-11"), "November 2026");
  });
  it("day and time: today, yesterday, this year, other years", () => {
    assert.equal(dayAndTime(new Date("2026-11-13T00:00:00Z"), NOW), "Today, 11:00 am");
    assert.equal(dayAndTime(new Date("2026-11-12T05:00:00Z"), NOW), "Yesterday, 4:00 pm");
    assert.equal(dayAndTime(new Date("2026-11-08T05:00:00Z"), NOW), "Sun 8 Nov, 4:00 pm");
    assert.equal(dayAndTime(new Date("2025-11-08T05:00:00Z"), NOW), "Sat 8 Nov 2025, 4:00 pm");
  });
  it("relative time, past and future", () => {
    assert.equal(relativeTime(new Date(NOW.getTime() - 10_000), NOW), "just now");
    assert.equal(relativeTime(new Date(NOW.getTime() - 5 * MIN), NOW), "5 min ago");
    assert.equal(relativeTime(new Date(NOW.getTime() - 3 * HOUR), NOW), "3 h ago");
    assert.equal(relativeTime(new Date(NOW.getTime() - 3 * 24 * HOUR), NOW), "3 days ago");
    assert.equal(relativeTime(new Date(NOW.getTime() + 20 * MIN), NOW), "in 20 min");
    assert.equal(relativeTime(new Date(NOW.getTime() + 20_000), NOW), "in under a minute");
  });
  it("durations and small helpers", () => {
    assert.equal(duration(7), "7 ms");
    assert.equal(duration(1234), "1.2 s");
    assert.equal(duration(125_000), "2 min 5 s");
    assert.equal(duration(null), "—");
    assert.equal(plural(1, "expense"), "1 expense");
    assert.equal(plural(2, "expense"), "2 expenses");
    assert.equal(shortId("19a8f3c2d1e0b7a4"), "19a8f3c2d1…");
  });
  it("schedules in plain words (every cron Jarvis uses)", () => {
    assert.equal(scheduleToWords("* * * * *"), "every minute");
    assert.equal(scheduleToWords("*/5 * * * *"), "every 5 min");
    assert.equal(scheduleToWords("*/30 * * * *"), "every 30 min");
    assert.equal(scheduleToWords("0 * * * *"), "every hour");
    assert.equal(scheduleToWords("0 */2 * * *"), "every 2 hours");
    assert.equal(scheduleToWords("0 9 * * *", "Australia/Sydney"), "daily 9am Sydney");
    assert.equal(scheduleToWords("0 21 * * *", "Australia/Sydney"), "daily 9pm Sydney");
    assert.equal(scheduleToWords("30 7 * * *"), "daily 7:30am");
    assert.equal(scheduleToWords("0 12 * * *"), "daily 12pm");
    assert.equal(scheduleToWords("0 0 * * *"), "daily 12am");
    assert.equal(scheduleToWords("0 9 * * 1"), "0 9 * * 1", "anything unusual is shown as the cron itself");
    assert.equal(scheduleToWords("nonsense"), "nonsense");
  });
});

// ---------------------------------------------------------------- escaping

describe("escaping", () => {
  const EVIL = `<img src=x onerror=alert(1)>"'&`;
  it("h`` escapes everything unless it is already Html", () => {
    assert.equal(h`<p>${EVIL}</p>`.toString(), `<p>&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;</p>`);
    assert.equal(h`<p>${h`<b>${"x<y"}</b>`}</p>`.toString(), "<p><b>x&lt;y</b></p>");
    assert.equal(h`${[h`<i>a</i>`, "<b>"]}`.toString(), "<i>a</i>&lt;b&gt;");
    assert.equal(h`${raw("<hr>")}${null}${undefined}${false}`.toString(), "<hr>");
  });
  it("untrusted text from merchants, chats, plans, tracks and emails never becomes markup on any page", () => {
    const c = ctx();
    addExpense(c, { merchant: `${EVIL} TEST`, category: EVIL, card: EVIL, error: EVIL, status: "pending", email: EVIL });
    addExpense(c, { merchant: EVIL });
    addJob(c, "heartbeat", "*/5 * * * *", { last: ago(MIN), next: ahead(4 * MIN) });
    addRun(c, "heartbeat", "failure", ago(MIN), { log: EVIL });
    const id = insertPlan(c.db, { title: EVIL, plan_status: "confirmed", source_chat_id: "G", source_chat_name: EVIL, raised_at: ago(HOUR), date: "2026-11-14", start_time: "19:00", location: EVIL, confidence: 0.9, date_certainty: "exact" }, NOW);
    updatePlan(c.db, id, { notes: [EVIL], participants: [EVIL], possible_link: { chat_id: "D", chat_name: EVIL, message_id: "m", confidence: 0.5, evidence: EVIL } }, NOW);
    c.db.prepare(`INSERT INTO processed_emails (message_id, processed_at, result, detail, dry_run) VALUES (?, ?, 'error', ?, 0)`).run(EVIL, ago(HOUR), EVIL);
    c.db.prepare(`INSERT INTO play_history (track_id, track_name, artists, played_at) VALUES ('t1', ?, ?, ?)`).run(EVIL, EVIL, ago(HOUR));
    const filter = { showTests: true };
    const pages = [
      overviewPage(buildOverview(c), NOW),
      expensesPage(buildExpenses(c.db, filter, NOW, true), filter, NOW),
      plansPage(buildPlans(c), NOW),
      spotifyPage(buildSpotify(c), NOW),
      invoicesPage(buildGmail(c), NOW),
      jobsPage({ jobs: buildJobs(c.db, c.registered, NOW), ...buildRuns(c.db, { all: true }), job: null, all: true }, NOW),
    ];
    for (const html of pages) {
      assert.ok(!/<img/i.test(html), "no raw <img> from data");
      assert.ok(!/onerror=alert/.test(html.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, "")), "the attribute text only appears escaped");
      assert.equal((html.match(/<script/g) ?? []).length, 1, "only our own script tag");
    }
    assert.match(pages[1], /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
  it("pages load nothing from outside: no external fonts, scripts, styles or images", () => {
    const c = ctx();
    for (const html of [overviewPage(buildOverview(c), NOW), jobsPage({ jobs: [], runs: [], hiddenNoisy: 0, job: null, all: false }, NOW)]) {
      assert.ok(!/(?:href|src)="https?:\/\//.test(html));
      assert.ok(!/@import|googleapis|cdn\./.test(html));
    }
  });
});

// ---------------------------------------------------------------- stale job detection

describe("overdue jobs", () => {
  const base = { enabled: true, retired: false, lastRunAt: new Date(NOW.getTime() - 5 * MIN), now: NOW };
  const state = (next: number | null, intervalMs: number, over: Partial<Parameters<typeof overdueState>[0]> = {}) =>
    overdueState({ ...base, nextRunAt: next === null ? null : new Date(NOW.getTime() + next), intervalMs, ...over });

  it("a job whose next run is in the future is fine", () => {
    assert.equal(state(2 * MIN, 5 * MIN).overdue, false);
  });
  it("a few minutes late is fine: the allowance is never under 10 minutes", () => {
    assert.equal(state(-4 * MIN, 5 * MIN).overdue, false);
    assert.equal(state(-9 * MIN, 5 * MIN).overdue, false);
    assert.equal(state(-11 * MIN, 5 * MIN).overdue, true, "more than 10 minutes late for a 5 minute job");
  });
  it("otherwise the allowance is 2 intervals", () => {
    assert.equal(state(-100 * MIN, 60 * MIN).overdue, false);
    assert.equal(state(-121 * MIN, 60 * MIN).overdue, true, "hourly job, over 2 intervals late");
    assert.equal(state(-47 * HOUR, 24 * HOUR).overdue, false, "daily job, under 2 days late");
    assert.equal(state(-49 * HOUR, 24 * HOUR).overdue, true);
  });
  it("the telegram-questions case: next run a day and a half in the past on a 30 minute job", () => {
    const r = state(-37 * HOUR, 30 * MIN);
    assert.equal(r.overdue, true);
    assert.match(r.reason ?? "", /schedule may have stopped/);
  });
  it("never reported: overdue once its first run is late, 'waiting' while it is not due", () => {
    assert.equal(state(-5 * MIN, 5 * MIN, { lastRunAt: null }).overdue, true);
    const waiting = state(3 * MIN, 5 * MIN, { lastRunAt: null });
    assert.deepEqual([waiting.overdue, waiting.waiting], [false, true]);
  });
  it("retired and disabled jobs are never overdue", () => {
    assert.equal(state(-37 * HOUR, 30 * MIN, { retired: true }).overdue, false);
    assert.equal(state(-37 * HOUR, 30 * MIN, { enabled: false }).overdue, false);
  });
});

describe("job rows", () => {
  it("a job in the database that the server no longer schedules is 'retired', not overdue (telegram-questions)", () => {
    const c = ctx();
    addJob(c, "telegram-questions", "*/30 * * * *", { last: "2026-11-11T00:30:00.005Z", next: "2026-11-11T01:00:00.000Z" });
    addJob(c, "heartbeat", "*/5 * * * *", { last: ago(2 * MIN), next: ahead(3 * MIN) });
    const jobs = buildJobs(c.db, c.registered, NOW);
    const old = jobs.find((j) => j.name === "telegram-questions")!;
    assert.deepEqual([old.retired, old.overdue], [true, false]);
    assert.equal(jobs.find((j) => j.name === "heartbeat")!.retired, false);
  });
  it("a registered job whose schedule stopped is overdue and turns the overview banner amber", () => {
    const c = ctx();
    addJob(c, "gmail-expenses", "0 * * * *", { last: ago(30 * HOUR), next: ago(29 * HOUR) });
    addRun(c, "gmail-expenses", "success", ago(30 * HOUR));
    const vm = buildOverview(c);
    assert.equal(vm.health.state, "warn");
    assert.ok(vm.health.items.some((i) => /gmail-expenses is overdue/.test(i.text) && i.link.startsWith("/jobs")));
    assert.equal(vm.tiles.find((t) => t.label === "Jobs failing or overdue")!.value, "1");
  });
  it("last status: a recorded run, a quiet success (no row kept), or never reported", () => {
    const c = ctx();
    addJob(c, "expenses-sync", "*/15 * * * *", { last: ago(3 * MIN), next: ahead(12 * MIN) });
    addRun(c, "expenses-sync", "success", ago(3 * MIN), { ms: 42 });
    addJob(c, "telegram-outbox", "* * * * *", { last: ago(MIN), next: ahead(MIN) }); // quiet: its row was deleted
    addJob(c, "heartbeat", "*/5 * * * *", { last: null, next: ahead(2 * MIN) });
    const by = Object.fromEntries(buildJobs(c.db, c.registered, NOW).map((j) => [j.name, j]));
    assert.deepEqual([by["expenses-sync"].lastStatus, by["expenses-sync"].quiet, by["expenses-sync"].lastDurationMs], ["success", false, 42]);
    assert.deepEqual([by["telegram-outbox"].lastStatus, by["telegram-outbox"].quiet, by["telegram-outbox"].lastDurationMs], ["success", true, null]);
    assert.deepEqual([by["heartbeat"].lastStatus, by["heartbeat"].waiting], [null, true]);
  });
  it("a failing job shows failing, and 3 in a row is an error on the banner", () => {
    const c = ctx();
    addJob(c, "gmail-expenses", "0 * * * *", { last: ago(10 * MIN), next: ahead(50 * MIN), failures: 3 });
    addRun(c, "gmail-expenses", "failure", ago(10 * MIN));
    const vm = buildOverview(c);
    assert.equal(vm.health.state, "error");
    assert.ok(vm.health.items.some((i) => /gmail-expenses failed 3 times in a row/.test(i.text) && i.severity === "error"));
  });
  it("the jobs page says 'no result reported' for a job that never reported, and flags overdue ones", () => {
    const c = ctx();
    addJob(c, "heartbeat", "*/5 * * * *", { last: null, next: ago(30 * MIN) });
    const html = jobsPage({ jobs: buildJobs(c.db, c.registered, NOW), runs: [], hiddenNoisy: 0, job: null, all: false }, NOW);
    assert.match(html, /No result reported/);
    assert.match(html, /Overdue/);
    assert.match(html, /every 5 min/);
    assert.match(html, /title="cron: \*\/5 \* \* \* \*"/);
  });
});

describe("run history", () => {
  it("hides heartbeat and plans-poll successes by default, failures first, with a show-all toggle", () => {
    const c = ctx();
    addRun(c, "heartbeat", "success", ago(10 * MIN));
    addRun(c, "plans-poll", "success", ago(9 * MIN));
    addRun(c, "expenses-sync", "success", ago(8 * MIN));
    addRun(c, "heartbeat", "failure", ago(7 * MIN));
    addRun(c, "gmail-expenses", "success", ago(6 * MIN));
    const def = buildRuns(c.db);
    assert.deepEqual(def.runs.map((r) => `${r.job}:${r.status}`), ["heartbeat:failure", "gmail-expenses:success", "expenses-sync:success"]);
    assert.equal(def.hiddenNoisy, 2);
    assert.equal(buildRuns(c.db, { all: true }).runs.length, 5);
    assert.deepEqual(buildRuns(c.db, { job: "heartbeat" }).runs.map((r) => r.status), ["failure", "success"], "one job's history shows everything");
  });
});

// ---------------------------------------------------------------- expenses

describe("expenses", () => {
  it("test rows are hidden by default, shown with the toggle, and never counted in totals", () => {
    const c = ctx();
    addExpense(c, { merchant: "Cafe", cents: 1000, category: "Food and drinks" });
    addExpense(c, { merchant: "JARVIS TEST (delete me)", cents: 1 });
    const hidden = buildExpenses(c.db, {}, NOW, true);
    assert.deepEqual(hidden.rows.map((r) => r.merchant), ["Cafe"]);
    assert.equal(hidden.hiddenTests, 1);
    assert.equal(hidden.tiles.totalCents, 1000);
    assert.equal(hidden.tiles.count, 1);
    const shown = buildExpenses(c.db, { showTests: true }, NOW, true);
    assert.equal(shown.rows.length, 2);
    assert.equal(shown.tiles.totalCents, 1000, "still excluded from the totals");
    assert.equal(isTestMerchant("JARVIS TEST (delete me)"), true);
    assert.equal(isTestMerchant("Contest Cafe"), false);
    assert.equal(isTestMerchant("Latest News"), false);
    assert.equal(isTestMerchant(null), false);
  });
  it("totals are AUD only, leave out merged duplicates and unreadable rows, and group by category", () => {
    const c = ctx();
    addExpense(c, { cents: 5000, category: "Fun" });
    addExpense(c, { cents: 2500, category: "Fun" });
    addExpense(c, { cents: 700 });
    addExpense(c, { cents: 1117, currency: "USD", category: "Jarvis and tech" });
    addExpense(c, { cents: 9999, status: "duplicate" });
    addExpense(c, { merchant: null, cents: null, status: "unparsed", parse: "unparsed" });
    const vm = buildExpenses(c.db, {}, NOW, true);
    assert.equal(vm.tiles.totalCents, 8200);
    assert.equal(vm.tiles.count, 3);
    assert.equal(vm.tiles.otherCurrencyCount, 1);
    assert.deepEqual(vm.tiles.byCategory, [{ name: "Fun", cents: 7500 }, { name: "Uncategorised", cents: 700 }]);
    assert.equal(vm.tiles.uncategorised, 1);
    assert.equal(vm.tiles.unreadable, 1);
  });
  it("months follow Sydney time, and the selector lists months with data", () => {
    const c = ctx();
    addExpense(c, { cents: 100, at: "2026-10-31T13:30:00Z" }); // 12:30am on 1 Nov in Sydney
    addExpense(c, { cents: 200, at: "2026-10-31T12:30:00Z" }); // 11:30pm on 31 Oct
    const nov = buildExpenses(c.db, { month: "2026-11" }, NOW, true);
    const oct = buildExpenses(c.db, { month: "2026-10" }, NOW, true);
    assert.equal(nov.tiles.totalCents, 100);
    assert.equal(oct.tiles.totalCents, 200);
    assert.deepEqual(nov.months, ["2026-11", "2026-10"]);
    assert.deepEqual([nov.prevMonth, nov.nextMonth, oct.prevMonth, oct.nextMonth], ["2026-10", null, null, "2026-11"]);
  });
  it("rows carry purchased and added times separately, and the right source and sheet status", () => {
    const c = ctx();
    addExpense(c, { merchant: "Email shop", source: "email", at: "2026-11-10T02:40:00Z", received: "2026-11-12T08:00:00Z", status: "pending", error: "boom", email: "abc123" });
    addExpense(c, { merchant: "Tapped", source: "tap", status: "pending" });
    addExpense(c, { merchant: "Typed", source: "manual", status: "synced" });
    const rows = Object.fromEntries(buildExpenses(c.db, {}, NOW, true).rows.map((r) => [r.merchant, r]));
    assert.equal(rows["Email shop"].purchasedAt.toISOString(), "2026-11-10T02:40:00.000Z");
    assert.equal(rows["Email shop"].addedAt.toISOString(), "2026-11-12T08:00:00.000Z");
    assert.deepEqual([rows["Email shop"].source, rows["Email shop"].sheetStatus, rows["Email shop"].tries], ["email", "failed", 3]);
    assert.equal(rows["Tapped"].sheetStatus, "pending");
    assert.equal(rows["Typed"].source, "manual");
  });
  it("filters by source, category, sheet status and search text", () => {
    const c = ctx();
    addExpense(c, { merchant: "Alpha Cafe", source: "tap", category: "Food and drinks" });
    addExpense(c, { merchant: "Beta Uber", source: "email", category: "Transport", status: "pending" });
    addExpense(c, { merchant: "Gamma", source: "email" });
    const names = (f: object) => buildExpenses(c.db, f, NOW, true).rows.map((r) => r.merchant).sort();
    assert.deepEqual(names({ source: "email" }), ["Beta Uber", "Gamma"]);
    assert.deepEqual(names({ category: "Transport" }), ["Beta Uber"]);
    assert.deepEqual(names({ category: "Uncategorised" }), ["Gamma"]);
    assert.deepEqual(names({ sheet: "pending" }), ["Beta Uber"]);
    assert.deepEqual(names({ q: "cafe" }), ["Alpha Cafe"]);
    assert.deepEqual(names({ q: "transport" }), ["Beta Uber"], "search also matches the category");
  });
  it("the page shows Purchased and Added columns, $ amounts, pills with words, and hides the test row", () => {
    const c = ctx();
    addExpense(c, { merchant: "McDonald's", cents: 1770, category: "Food and drinks", source: "email", at: "2026-11-08T11:42:00Z", received: "2026-11-12T08:00:00Z" });
    addExpense(c, { merchant: "Pending one", status: "pending" });
    addExpense(c, { merchant: "JARVIS TEST (delete me)", cents: 1 });
    const html = expensesPage(buildExpenses(c.db, {}, NOW, true), {}, NOW);
    assert.match(html, />Purchased</);
    assert.match(html, />Added</);
    assert.match(html, /\$17\.70/);
    assert.match(html, /Sun 8 Nov, 10:42 pm/, "purchase time in Sydney time");
    assert.match(html, /pill-warn[^>]*>.*Pending/s);
    assert.ok(!html.includes("JARVIS TEST"), "test row hidden");
    assert.match(html, /1 test row hidden/);
    assert.match(html, /<caption>/);
  });
  it("a month with nothing shows an empty state, not an empty table", () => {
    const html = expensesPage(buildExpenses(ctx().db, {}, NOW, true), {}, NOW);
    assert.match(html, /class="empty"/);
    assert.ok(!html.includes("<table"));
  });
});

// ---------------------------------------------------------------- AI spend, spotify, gmail, plans

describe("AI spend", () => {
  it("sums all features for the cap and breaks them down, with any untagged earlier spend shown", () => {
    const c = ctx();
    c.db.prepare(`INSERT INTO api_usage (provider, date, units_used, limit_units, input_tokens, output_tokens, cost_usd) VALUES ('ai_gateway', '2026-11-12', 10, 100, 0, 0, 0.0200)`).run();
    c.db.prepare(`INSERT INTO ai_usage_by_feature (feature, date, calls, cost_usd) VALUES ('plans', '2026-11-12', 4, 0.0100), ('invoices', '2026-11-12', 2, 0.0050)`).run();
    const ai = buildAiUsage(c.db, NOW);
    assert.ok(Math.abs(ai.spendUsd - 0.02) < 1e-9);
    assert.deepEqual(ai.byFeature.map((f) => [f.label, f.calls]), [["Plans", 4], ["Invoices", 2]]);
    assert.ok(Math.abs(ai.untaggedUsd - 0.005) < 1e-9);
  });
  it("80% of the cap warns on the overview, 100% is an error", () => {
    const c = ctx();
    c.db.prepare(`INSERT INTO api_usage (provider, date, units_used, limit_units, input_tokens, output_tokens, cost_usd) VALUES ('ai_gateway', '2026-11-12', 1, 100, 0, 0, 8.5)`).run();
    assert.equal(buildOverview(c).health.state, "warn");
    c.db.prepare(`UPDATE api_usage SET cost_usd = 10.5`).run();
    assert.equal(buildOverview(c).health.state, "error");
  });
});

describe("overview health", () => {
  it("everything fine: green banner, six tiles, six modules", () => {
    const c = ctx();
    addJob(c, "heartbeat", "*/5 * * * *", { last: ago(2 * MIN), next: ahead(3 * MIN) });
    const vm = buildOverview(c);
    const html = overviewPage(vm, NOW);
    assert.equal(vm.health.state, "ok");
    assert.match(html, /Everything is running/);
    assert.equal(vm.tiles.length, 6);
    assert.deepEqual(vm.modules.map((m) => m.key), ["expenses", "gmail", "spotify", "telegram", "plans", "beeper"]);
  });
  it("a problem names itself, links to its page, and counts", () => {
    const c = ctx({ flags: { spotifyConnected: false, gmailConnected: false } });
    addExpense(c, { status: "pending", error: "Sheets 500" });
    const vm = buildOverview(c);
    assert.equal(vm.health.state, "error");
    const html = overviewPage(vm, NOW);
    assert.match(html, /things need attention/);
    assert.match(html, /href="\/spotify"/);
    assert.match(html, /href="\/gmail"/);
    assert.match(html, /Spotify is not connected/);
    assert.match(html, /Failing/);
  });
  it("modules that are not set up are Off, not failing", () => {
    const c = ctx({ flags: { beeperConfigured: false, telegramConfigured: false, spotifyConfigured: false } });
    const states = Object.fromEntries(buildOverview(c).modules.map((m) => [m.key, m.state]));
    assert.deepEqual([states.beeper, states.telegram, states.spotify, states.plans], ["off", "off", "off", "off"]);
  });
  it("the status pill always has a word and an icon, never colour alone", () => {
    for (const kind of ["ok", "warn", "error", "off", "dry", "live", "info"] as const) {
      const html = StatusPill(kind).toString();
      assert.match(html, /class="pill-icon" aria-hidden="true">\S</);
      assert.match(html, /<\/span>[A-Za-z ]+<\/span>$/);
    }
    assert.match(StatusPill("warn").toString(), /Needs attention/);
    assert.match(StatusPill("error").toString(), /Failing/);
  });
});

describe("spotify and invoices", () => {
  it("shows plays as progress toward the threshold and the right liked label", () => {
    const c = ctx({ flags: { spotifyDryRun: true } });
    addJob(c, "spotify-likes", "0 */2 * * *", { last: ago(HOUR), next: ahead(HOUR) });
    const play = (id: string, name: string, times: number) => {
      for (let i = 0; i < times; i++) c.db.prepare(`INSERT INTO play_history (track_id, track_name, artists, played_at) VALUES (?, ?, 'Artist', ?)`).run(id, name, ago((i + 1) * HOUR));
    };
    play("a", "Three plays", 3);
    play("b", "Six plays", 6);
    c.db.prepare(`INSERT INTO track_status (track_id, is_liked, checked_at) VALUES ('a', 0, ?), ('b', 0, ?)`).run(ago(HOUR), ago(HOUR));
    const vm = buildSpotify(c);
    const by = Object.fromEntries(vm.tracks.map((t) => [t.name, t]));
    assert.equal(vm.threshold, 5);
    assert.deepEqual([by["Three plays"].playsInWindow, by["Three plays"].liked], [3, "not"]);
    assert.deepEqual([by["Six plays"].playsInWindow, by["Six plays"].liked], [6, "due"]);
    const html = spotifyPage(vm, NOW);
    assert.match(html, /3 \/ 5/);
    assert.match(html, /Would like \(dry run\)/);
    assert.match(html, /5 plays in 2 days/);
    assert.match(html, /Run now/);
  });
  it("the invoices page filters by result and links ids to Gmail", () => {
    const c = ctx();
    const add = (id: string, result: string) => c.db.prepare(`INSERT INTO processed_emails (message_id, processed_at, result, detail, dry_run) VALUES (?, ?, ?, 'detail', 0)`).run(id, ago(HOUR), result);
    add("19a8f3c2d1e0b7a4aaaa", "invoice");
    add("29a8f3c2d1e0b7a4bbbb", "not_invoice");
    add("39a8f3c2d1e0b7a4cccc", "error");
    assert.equal(buildGmail(c).emails.length, 3);
    assert.deepEqual(buildGmail(c, { filter: "error" }).emails.map((e) => e.result), ["error"]);
    assert.equal(buildGmail(c, { filter: "bogus" }).filter, null, "an unknown filter is ignored");
    const html = invoicesPage(buildGmail(c), NOW);
    assert.match(html, /mail\.google\.com\/mail\/u\/0\/#all\/19a8f3c2d1e0b7a4aaaa/);
    assert.match(html, /19a8f3c2d1e0…/);
    assert.match(html, /All time/);
  });
});

describe("plans", () => {
  it("groups plans into needs attention, upcoming, proposed and past, and shows the dry-run log only in dry run", () => {
    const c = ctx({ flags: { plansDryRun: false } });
    const mk = (title: string, o: { stance?: "committed" | "declined" | "unsure"; status?: "confirmed" | "proposed" | "cancelled"; date?: string; replied?: boolean } = {}) => {
      const id = insertPlan(c.db, { title, plan_status: o.status ?? "confirmed", source_chat_id: "G", source_chat_name: "Footy boys", raised_at: ago(2 * HOUR), date: o.date ?? "2026-11-14", start_time: "19:00", confidence: 0.9, date_certainty: "exact" }, NOW);
      if (o.stance) addStance(c.db, id, { stance: o.stance, message_id: `s${id}`, chat_id: "G", ts: ago(HOUR) }, NOW);
      if (o.replied) updatePlan(c.db, id, { replied_at: ago(MIN) }, NOW);
      return id;
    };
    mk("Going", { stance: "committed", replied: true });
    mk("Floated", { status: "proposed", replied: true });
    mk("Gone", { date: "2026-11-01" });
    mk("Off", { status: "cancelled" });
    const vm = buildPlans(c);
    assert.deepEqual([vm.upcoming.length, vm.proposed.length, vm.past.length], [1, 1, 2]);
    const html = plansPage(vm, NOW);
    assert.match(html, /Upcoming, I&#39;m going/);
    assert.match(html, /Past, cancelled or declined \(2\)/);
    assert.match(html, /Going<\/span>/, "stance pill with a word");
    assert.ok(!html.includes("Dry run: what Jarvis would do"));
    assert.match(plansPage(buildPlans(ctx({ flags: { plansDryRun: true } })), NOW), /Dry run: what Jarvis would do/);
  });
  it("names what is being read, clearly", () => {
    assert.equal(buildPlans(ctx({ flags: { plansAllChats: true } })).status.scope, "Instagram, all chats");
    assert.match(buildPlans(ctx({ flags: { plansAllChats: false } })).status.scope, /allowlisted chat/);
  });
});

// ---------------------------------------------------------------- shell, tables, empty data

describe("page shell and components", () => {
  it("every page has the shared nav, a skip link, a title, light and dark support, and a viewport", () => {
    const html = PageLayout({ title: "Overview", active: "overview", body: h`<p>hi</p>`, now: NOW });
    for (const label of ["Overview", "Expenses", "Plans", "Spotify", "Invoices", "Jobs"]) assert.match(html, new RegExp(`>${label}</a>`));
    assert.match(html, /aria-current="page">Overview/);
    assert.match(html, /class="skip"/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<meta name="color-scheme" content="light dark">/);
    assert.match(html, /<title>Overview · Jarvis<\/title>/);
    assert.match(html, /Sydney time/);
  });
  it("tables are real tables with a caption, labelled cells for the stacked mobile layout, and an empty state", () => {
    const table = DataTable({ caption: "Things", columns: [{ label: "Name", sort: "text" }, { label: "Amount", align: "right", sort: "num" }], rows: [{ cells: ["a", { html: h`<b>1</b>`, sort: 1 }] }], empty: h`<p>none</p>` }).toString();
    assert.match(table, /<caption>Things<\/caption>/);
    assert.match(table, /<th scope="col"/);
    assert.match(table, /data-label="Name"/);
    assert.match(table, /data-label="Amount"/);
    assert.equal(DataTable({ caption: "x", columns: [{ label: "A" }], rows: [], empty: h`<p>none</p>` }).toString(), "<p>none</p>");
  });
  it("a banner is announced to screen readers and has a title", () => {
    assert.match(Banner("error", "Broke").toString(), /role="alert"/);
    assert.match(Banner("ok", "Fine").toString(), /role="status"/);
  });
  it("every page renders with completely empty data, with no 'undefined' or 'NaN' on it", () => {
    const c = ctx({ registered: [] });
    const filter = {};
    const pages = [
      overviewPage(buildOverview(c), NOW),
      expensesPage(buildExpenses(c.db, filter, NOW, false), filter, NOW),
      plansPage(buildPlans(ctx({ flags: { plansDryRun: true, beeperConfigured: false, calendarConnected: false } })), NOW),
      spotifyPage(buildSpotify(ctx({ flags: { spotifyConfigured: false, spotifyConnected: false } })), NOW, { busy: true }),
      invoicesPage(buildGmail(ctx({ flags: { gmailConfigured: false, gmailConnected: false, aiConfigured: false } })), NOW, { busy: true }),
      jobsPage({ jobs: [], runs: [], hiddenNoisy: 0, job: null, all: false }, NOW),
    ];
    for (const html of pages) {
      assert.ok(!/undefined|NaN|\[object/.test(html), "no leaked values");
      assert.match(html, /<main id="main"/);
    }
  });
});
