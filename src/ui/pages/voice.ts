import { Banner, BarList, Card, DataTable, EmptyState, Facts, Moment, PageLayout, Progress, RelativeTime, Section, StatTile, StatusPill, TileRow } from "../components";
import { duration, usd } from "../format";
import { h } from "../html";
import type { CallRowVM, VoiceVM } from "../vm/voice";

// The Calls page: spend against the monthly limit, the calls, which tools were used, and what failed. Summaries only.

const resultPill = (r: string) => (r === "answered" ? StatusPill("ok", "Answered") : r === "voicemail" ? StatusPill("warn", "Voicemail") : r === "in progress" ? StatusPill("info", "In progress") : StatusPill("error", "Not answered"));

function table(calls: CallRowVM[], now: Date) {
  return DataTable({
    caption: "Calls (newest first, the last 100)",
    id: "calls",
    columns: [
      { label: "When", sort: "num" },
      { label: "Direction" },
      { label: "Duration", align: "right", sort: "num" },
      { label: "Cost", align: "right", sort: "num" },
      { label: "Result" },
      { label: "Summary" },
    ],
    rows: calls.map((c) => ({
      className: c.result === "not answered" ? "row-warn" : undefined,
      cells: [
        { html: h`${Moment(c.at)} <span class="muted">(${RelativeTime(c.at, now)})</span>`, sort: c.at.getTime() },
        c.direction === "inbound" ? "You called Jarvis" : c.alert ? "Jarvis called (alert)" : "Jarvis called",
        { html: h`<span class="num">${c.durationS === null ? "—" : duration(c.durationS * 1000)}</span>`, sort: c.durationS ?? -1 },
        { html: h`<span class="num">${c.costUsd === null ? "—" : usd(c.costUsd, 3)}</span>`, sort: c.costUsd ?? -1 },
        { html: resultPill(c.result), mobileHide: c.result === "answered" },
        h`${c.summary ?? ""}${c.endedReason ? h` <span class="muted">(${c.endedReason})</span>` : ""}`,
      ],
    })),
    empty: EmptyState("No calls yet", "Phone the Jarvis number, or wait for an alert."),
  });
}

export function voicePage(vm: VoiceVM, now: Date): string {
  const f = vm.flags;
  const banner = !f.enabled
    ? Banner("warn", "Voice is switched off", [{ text: "VOICE_ENABLED=false in .env: every voice request gets a polite refusal." }])
    : !f.configured
      ? Banner("warn", "Voice is not set up", [{ text: "Needs VAPI_API_KEY, VAPI_WEBHOOK_SECRET and OWNER_PHONE in .env, then npm run voice:push." }])
      : vm.level === "capped"
        ? Banner("error", "The monthly voice limit is reached", [{ text: `${usd(vm.spentUsd)} of ${usd(vm.capUsd, 0)}: no outbound calls, and the phone tools say the limit has been reached.` }])
        : vm.level === "warn"
          ? Banner("warn", `Voice spend is at ${Math.round(vm.fraction * 100)}% of the monthly limit`)
          : "";

  const tiles = TileRow([
    StatTile({ label: "Spend this month", value: usd(vm.spentUsd), sub: `of ${usd(vm.capUsd, 0)} limit`, state: vm.level === "capped" ? "error" : vm.level === "warn" ? "warn" : "ok" }),
    StatTile({ label: "Calls this month", value: String(vm.callsThisMonth), sub: `${vm.inboundThisMonth} in · ${vm.outboundThisMonth} out` }),
    StatTile({ label: "Last call", value: vm.lastCall ? RelativeTime(vm.lastCall.at, now) : "none yet", sub: vm.lastCall ? `${vm.lastCall.direction === "inbound" ? "you called" : "Jarvis called"} · ${vm.lastCall.result}` : undefined }),
    StatTile({ label: "Tool calls", value: String(vm.toolCalls), sub: vm.toolFailures ? `${vm.toolFailures} failed` : "none failed", state: vm.toolFailures ? "warn" : "ok" }),
    StatTile({ label: "Home Assistant writes", value: f.writesLive ? StatusPill("live") : StatusPill("dry"), sub: f.writesLive ? "voice can change things" : "says what it would do" }),
    StatTile({ label: "PIN", value: f.pinSet ? StatusPill("ok", "Set") : StatusPill("warn", "Not set"), sub: f.pinSet ? "needed to open the garage" : "npm run voice:set-pin" }),
  ]);

  const alerts = vm.openAlerts.length
    ? h`<ul class="banner-list issues">${vm.openAlerts.map((a) => h`<li>${a.kind.replace("_", " ")}: open since ${Moment(a.since)}, ${a.attemptsToday} call${a.attemptsToday === 1 ? "" : "s"} today${a.lastAttemptAt ? h`, last ${RelativeTime(a.lastAttemptAt, now)}` : ""}</li>`)}</ul>`
    : h`<p class="muted">Nothing needs a phone call right now.</p>`;

  const toolsBody = vm.tools.length
    ? BarList(vm.tools.map((t) => ({ label: t.tool, value: t.calls, text: h`${t.calls}${t.failures ? h` <span class="muted">· ${t.failures} failed</span>` : ""}` })))
    : EmptyState("No tools used this month");

  const body = h`${banner}
${tiles}
${Section("Spend against the monthly limit", h`${Progress(Math.min(100, Math.round(vm.fraction * 100)), 100, `${Math.round(vm.fraction * 100)}% of the monthly limit`)}<p class="note">Cost is what Vapi reports for each call. Twilio's own charges are billed by Twilio and are not included.</p>`)}
${Section("Alerts", alerts)}
${Section("Tools used this month", toolsBody)}
${Section("Calls", table(vm.calls, now), vm.calls.length)}
${Card({ title: "How it is set up", body: Facts([{ label: "Kept per call", value: "a one-line summary, the cost and how it ended. No transcript, no recording." }, { label: "Who can call", value: "only your own number; anyone else is turned away" }, { label: "Switch it off", value: "VOICE_ENABLED=false in .env, then restart" }]) })}`;
  return PageLayout({ title: "Calls", active: "calls", body, now, subtitle: "Phone calls with Jarvis (Vapi + Twilio)" });
}
