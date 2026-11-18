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
  <p class="plan-meta">${p.when}${p.where ? (p.mapUrl ? h` · <a href="${p.mapUrl}" target="_blank" rel="noreferrer noopener">${p.where} (map)</a>` : h` · ${p.where}`) : ""}</p>
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

export interface PlaceFlash {
  ok?: string;
  err?: string;
}

function placesBlock(vm: PlansVM, flash: PlaceFlash): Html {
  const unverified = vm.places.filter((p) => p.address && !p.verified).length;
  const banner = !vm.mapsConfigured
    ? Banner("warn", "Google Maps isn't configured yet", [{ text: "Addresses are saved as you type them and shown as not verified. Add GOOGLE_MAPS_API_KEY to .env and restart Jarvis to have Google find the full address." }])
    : "";
  const msg = flash.err ? Banner("error", flash.err) : flash.ok ? Banner("ok", flash.ok) : "";
  const verifyAll = vm.mapsConfigured && unverified > 0 ? h`<form method="post" action="/plans/places/verify-all" class="inline"><button class="btn" type="submit">Look up ${unverified} unverified address${unverified === 1 ? "" : "es"} on Google</button></form>` : "";
  const table = DataTable({
    caption: "Places Jarvis knows (the AI only sees the names). The address is the one Google found.",
    id: "places",
    columns: [{ label: "Place" }, { label: "Address" }, { label: "Status" }, { label: "" }],
    rows: vm.places.map((p) => ({
      cells: [
        p.name,
        p.address ? (p.mapUrl ? h`<a href="${p.mapUrl}" target="_blank" rel="noreferrer noopener">${p.address}</a>${p.verified && p.typed && p.typed !== p.address ? h`<br><span class="muted">you wrote: ${p.typed}</span>` : ""}` : p.address) : h`<span class="muted">not given yet</span>`,
        p.verified ? StatusPill("ok", "On Google Maps") : p.address ? StatusPill("warn", "Not verified") : StatusPill("off", "No address"),
        h`<details class="place-edit"><summary>Edit</summary>
<form method="post" action="/plans/places/${p.id}/save" class="place-form">
  <label>Name <input type="text" name="name" value="${p.name}" maxlength="60" required></label>
  <label>Address <input type="text" name="address" value="${p.typed ?? p.address ?? ""}" maxlength="200" placeholder="e.g. 16 Horsfield Street"></label>
  <button class="btn primary" type="submit">Save and look up</button>
</form>
<form method="post" action="/plans/places/${p.id}/delete" class="inline" onsubmit="return confirm('Delete this place? Plans keep their text; Jarvis will ask again if it comes up.')"><button class="btn danger" type="submit">Delete</button></form></details>`,
      ],
    })),
    empty: EmptyState("No saved places yet", "Jarvis asks on Telegram when a plan is at somewhere new, like a friend's house."),
    sortable: false,
  });
  return h`<div id="places">${banner}${msg}${verifyAll}${table}</div>`;
}

export function plansPage(vm: PlansVM, now: Date, flash: PlaceFlash = {}): string {
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
${Section("Saved places", placesBlock(vm, flash), vm.places.length)}
<details class="fold"><summary>Past, cancelled or declined (${vm.past.length})</summary><div class="stack">${list(vm.past, now, "Nothing here yet.")}</div></details>
${vm.showWould ? Section("Dry run: what Jarvis would do", would) : ""}`;
  return PageLayout({ title: "Plans", active: "plans", body, now });
}

