import { esc } from "../html";
import { whenLabel, wantsEvent } from "./actions";
import { planCode, type Plan } from "./store";

// The HTML for /plans. Pure functions (plans in, HTML out) so it can be tested. Everything that
// came from a chat is untrusted, so every value goes through esc().

const fmt = (iso: string) => new Date(iso).toLocaleString("en-AU", { hour12: false, timeZone: "Australia/Sydney" });

function planRow(p: Plan, extra = ""): string {
  const chats = [p.source_chat_name, ...p.linked_chats.map((l) => l.name)];
  const details = [
    p.what ? esc(p.what) : "",
    p.location ? `Where: ${esc(p.location)}` : "",
    p.meeting_point ? `Meet: ${esc(p.meeting_point)}` : "",
    p.participants.length ? `With: ${esc(p.participants.join(", "))}` : "",
    p.cost ? `Cost: ${esc(p.cost)}` : "",
    p.bring ? `Bring: ${esc(p.bring)}` : "",
    // Only http(s) links are ever stored (checked in apply.ts), and the value is escaped regardless.
    p.url ? `Link: <a href="${esc(p.url)}" target="_blank" rel="noreferrer noopener">${esc(p.url)}</a>` : "",
    ...p.notes.map((n) => `Note: ${esc(n)}`),
  ].filter(Boolean);
  const statusClass = p.plan_status === "confirmed" ? "success" : p.plan_status === "cancelled" ? "failure" : "pending";
  return `<tr>
    <td><strong>${esc(planCode(p.id))}</strong> ${esc(p.title)}<br><span class="muted">${esc(whenLabel(p))}${p.date_certainty === "ambiguous" ? " (day unclear)" : ""}</span>${extra}</td>
    <td>${details.map((d) => `<div>${d}</div>`).join("") || `<span class="muted">no more details</span>`}</td>
    <td>${esc(chats.join(", "))}</td>
    <td>${esc(p.my_stance === "none" ? "no reply yet" : p.my_stance)}<br><span class="${statusClass}">${esc(p.plan_status)}</span></td>
    <td class="muted">${esc(fmt(p.last_updated))}${p.event_link ? `<br><a href="${esc(p.event_link)}" target="_blank" rel="noreferrer noopener">on calendar</a>` : ""}</td></tr>`;
}
const table = (rows: string) =>
  rows ? `<table><tr><th>Plan</th><th>Details</th><th>Chat(s)</th><th>Me / status</th><th>Updated</th></tr>${rows}</table>` : `<p class="muted">Nothing here.</p>`;

export interface WouldRow {
  plan_id: number;
  kind: string;
  detail: string | null;
  created_at: string;
}

export function plansBody(opts: { plans: Plan[]; today: string; dryRun: boolean; would: WouldRow[]; chatsLine: string; statusHtml: string }): string {
  const { plans, today } = opts;
  const live = plans.filter((p) => !p.archived_at && p.plan_status !== "cancelled" && p.my_stance !== "declined" && (p.date === null || p.date >= today));
  const unreplied = (p: Plan) => p.replied_at === null && p.my_stance !== "committed" && p.my_stance !== "declined";
  const needs = live.filter((p) => unreplied(p) || (p.my_stance === "committed" && p.date_certainty === "ambiguous") || p.possible_link);
  const clashes = live.filter((p) => p.cal_state === "clash");
  const upcoming = live.filter((p) => p.my_stance === "committed").sort((a, b) => (a.date ?? "9").localeCompare(b.date ?? "9"));
  const proposed = live.filter((p) => p.my_stance !== "committed");
  const past = plans.filter((p) => !live.includes(p));

  const why = (p: Plan) => {
    const bits = [
      unreplied(p) ? "you haven't replied" : "",
      p.date_certainty === "ambiguous" ? "day is unclear" : "",
      p.possible_link ? `possible link to a message in ${esc(p.possible_link.chat_name)} (${Math.round(p.possible_link.confidence * 100)}% sure: ${esc(p.possible_link.evidence)})` : "",
    ].filter(Boolean);
    return `<br><span class="pending">${bits.join(" · ")}</span>`;
  };
  const wouldRows = opts.would
    .map((a) => `<tr><td>${esc(fmt(a.created_at))}</td><td>${esc(planCode(a.plan_id))}</td><td>${esc(a.kind.replace("would_", "would "))}</td><td>${esc(a.detail ?? "")}</td></tr>`)
    .join("");

  return `<p><a href="/">&larr; Jobs</a></p>
<h1>Plans</h1>
${opts.statusHtml}
<h2>Needs my attention (${needs.length})</h2>${table(needs.map((p) => planRow(p, why(p))).join(""))}
<h2>Clashes (${clashes.length})</h2>${table(clashes.map((p) => planRow(p, `<br><span class="failure">clashes with something on your calendar. Reply /addanyway ${esc(planCode(p.id))} on Telegram to add it anyway.</span>`)).join(""))}
<h2>Upcoming, I'm going (${upcoming.length})</h2>${table(upcoming.map((p) => planRow(p, wantsEvent(p) ? "" : `<br><span class="pending">not on the calendar: needs confirmed, an exact day and time</span>`)).join(""))}
<h2>Proposed / waiting (${proposed.length})</h2>${table(proposed.map((p) => planRow(p)).join(""))}
<details><summary><strong>Past, cancelled or declined (${past.length})</strong></summary>${table(past.map((p) => planRow(p)).join(""))}</details>
${opts.dryRun ? `<h2>Dry run: what Jarvis WOULD have done</h2><table><tr><th>When</th><th>Plan</th><th>Action</th><th>Detail</th></tr>${wouldRows || `<tr><td colspan="4" class="muted">Nothing yet.</td></tr>`}</table>` : ""}
<h2>Chats being read</h2>
<p class="muted">${opts.chatsLine}</p>`;
}
