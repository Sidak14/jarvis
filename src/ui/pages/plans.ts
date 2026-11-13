import { Banner, DataTable, EmptyState, Moment, PageLayout, RelativeTime, Section, StatTile, StatusPill, TileRow } from "../components";
import { usd } from "../format";
import { h, type Html } from "../html";
import type { PlansVM } from "../vm/plans";
import type { PlanVM } from "../vm/types";

// Plans: a status strip, then cards for each group of plans (not bare lists).

const stancePill = (s: PlanVM["myStance"]) =>
  s === "committed" ? StatusPill("ok", "Going") : s === "declined" ? StatusPill("off", "Declined") : s === "unsure" ? StatusPill("warn", "Unsure") : StatusPill("off", "No reply yet");
const statusPill = (s: PlanVM["planStatus"]) => (s === "confirmed" ? StatusPill("ok", "Confirmed") : s === "cancelled" ? StatusPill("error", "Cancelled") : StatusPill("info", "Proposed"));

function planCard(p: PlanVM, now: Date, note?: Html): Html {
  const chip = p.dayChip ? h`<div class="plan-date"><b>${p.dayChip.day}</b><span>${p.dayChip.month}</span></div>` : h`<div class="plan-date none"><span>No date</span></div>`;
  const extra = p.details.length || p.url ? h`<div class="plan-extra">${p.details.map((d) => h`<div>${d}</div>`)}${p.url ? h`<div>Link: <a href="${p.url}" target="_blank" rel="noreferrer noopener">${p.url}</a></div>` : ""}</div>` : "";
  return h`<article class="plan">
${chip}
<div class="plan-main">
  <p class="plan-title"><span class="muted mono">${p.id}</span> ${p.title}</p>
  <p class="plan-meta">${p.when}${p.where ? h` · ${p.where}` : ""}</p>
  <p class="plan-meta">Chat: ${p.chat}</p>
  <div class="plan-pills">${stancePill(p.myStance)}${statusPill(p.planStatus)}${p.clash ? StatusPill("error", "Calendar clash") : ""}${p.onCalendar && !p.clash ? StatusPill("ok", "Calendar-ready") : ""}</div>
  ${p.why.length ? h`<p class="plan-why">${p.why.join(" · ")}</p>` : ""}
  ${note ?? ""}
  <p class="plan-meta">Updated ${RelativeTime(p.updatedAt, now)}${p.calendarUrl ? h` · <a href="${p.calendarUrl}" target="_blank" rel="noreferrer noopener">On calendar</a>` : ""}</p>
</div>
${extra}
</article>`;
}

const list = (plans: PlanVM[], now: Date, empty: string, note?: (p: PlanVM) => Html | undefined) =>
  plans.length ? h`<div class="plans">${plans.map((p) => planCard(p, now, note?.(p)))}</div>` : EmptyState(empty);

export function plansPage(vm: PlansVM, now: Date): string {
  const s = vm.status;
  const beeper = !s.beeper.configured ? StatusPill("off", "Not configured") : s.beeper.error ? StatusPill("error", "Not connected") : s.beeper.lastPollAt ? StatusPill("ok", "Connected") : StatusPill("info", "Starting");
  const strip = TileRow([
    StatTile({ label: "Beeper", value: beeper, sub: s.beeper.error ? s.beeper.error : `${s.beeper.accounts ?? "?"} accounts · polled ${s.beeper.lastPollAt ? "recently" : "never"}` }),
    StatTile({ label: "Chats read", value: s.scope }),
    StatTile({ label: "Mode", value: s.dryRun ? StatusPill("dry") : StatusPill("live"), sub: s.dryRun ? "no pings or calendar changes" : "pings and calendar are on" }),
    StatTile({ label: "AI spend", value: usd(s.ai.spendUsd), sub: `of ${usd(s.ai.capUsd, 0)} this month (all features)` }),
    StatTile({ label: "Calendar", value: s.calendarConnected ? StatusPill("ok", "Connected") : StatusPill("warn", "Not connected"), sub: s.calendarConnected ? "Google Calendar" : undefined, href: s.calendarConnected ? undefined : "/calendar/login" }),
    StatTile({ label: "Last batch", value: s.lastBatchSummary ?? "none yet", sub: s.lastBatchAt ? h`${RelativeTime(s.lastBatchAt, now)} · ${s.foundThisWeek} found this week · ${s.messagesWaiting} waiting` : `${s.messagesWaiting} messages waiting` }),
  ]);

  const would = DataTable({
    caption: "What Jarvis would have done (dry run)",
    columns: [{ label: "When" }, { label: "Plan" }, { label: "Action" }, { label: "Detail" }],
    rows: vm.would.map((w) => ({ cells: [Moment(w.at), h`<span class="mono">${w.plan}</span>`, w.action, w.detail] })),
    empty: EmptyState("Nothing yet", "Dry run records what it would add to your calendar or ping you about."),
    sortable: false,
  });

  const body = h`${s.runError ? Banner("warn", "The last plans run had a problem", [{ text: s.runError }]) : ""}
${strip}
${Section("Needs my attention", list(vm.needs, now, "Nothing needs a reply."), vm.needs.length)}
${Section("Clashes", list(vm.clashes, now, "No clashes with your calendar.", (p) => h`<p class="plan-why">Reply /addanyway ${p.id} on Telegram to add it anyway.</p>`), vm.clashes.length)}
${Section("Upcoming, I'm going", list(vm.upcoming, now, "Nothing coming up yet.", (p) => (p.onCalendar ? undefined : h`<p class="plan-why">Not on the calendar yet: needs confirmed, an exact day and time.</p>`)), vm.upcoming.length)}
${Section("Proposed / waiting", list(vm.proposed, now, "No open proposals."), vm.proposed.length)}
<details class="fold"><summary>Past, cancelled or declined (${vm.past.length})</summary><div class="stack">${list(vm.past, now, "Nothing here yet.")}</div></details>
${vm.showWould ? Section("Dry run: what Jarvis would do", would) : ""}`;
  return PageLayout({ title: "Plans", active: "plans", body, now });
}

