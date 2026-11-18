import type Database from "better-sqlite3";
import { classifyEnd, openEpisodes } from "../../voice/alerts";
import { budget, type BudgetLevel } from "../../voice/budget";
import { monthKey, monthRange } from "../../telegram/time";
import type { Fact, JobVM, ModuleStatus, State, VoiceFlags } from "./types";

// The Calls page and the Overview's Voice card: spend against the monthly limit, the calls, the tools used, and anything that
// failed. Only summaries are ever shown: Jarvis keeps no transcripts or recordings.

export interface CallRowVM {
  id: string;
  at: Date;
  direction: "inbound" | "outbound";
  durationS: number | null;
  costUsd: number | null;
  /** Plain words: "answered", "voicemail", "not answered", "in progress". */
  result: string;
  endedReason: string | null;
  summary: string | null;
  alert: boolean;
  tools: string[];
}
export interface VoiceVM {
  flags: VoiceFlags;
  spentUsd: number;
  capUsd: number;
  fraction: number;
  level: BudgetLevel;
  callsThisMonth: number;
  inboundThisMonth: number;
  outboundThisMonth: number;
  lastCall: CallRowVM | null;
  tools: { tool: string; calls: number; failures: number }[];
  toolCalls: number;
  toolFailures: number;
  calls: CallRowVM[];
  openAlerts: { kind: string; since: Date; attemptsToday: number; lastAttemptAt: Date | null }[];
}

interface DbCall {
  call_id: string;
  direction: "inbound" | "outbound";
  started_at: string;
  ended_at: string | null;
  duration_s: number | null;
  cost_usd: number | null;
  ended_reason: string | null;
  summary: string | null;
  alert_episode_id: number | null;
}

export function resultWords(ended: string | null, reason: string | null, durationS: number | null): string {
  if (!ended) return "in progress";
  const outcome = classifyEnd(reason, durationS);
  return outcome === "voicemail" ? "voicemail" : outcome === "unanswered" ? "not answered" : "answered";
}

export function buildVoice(db: Database.Database, now: Date, flags: VoiceFlags): VoiceVM {
  const b = budget(db, now, flags.capUsd);
  const { start, end } = monthRange(monthKey(now));
  const month = [start.toISOString(), end.toISOString()];
  const toolsByCall = new Map<string, string[]>();
  for (const t of db.prepare(`SELECT call_id, tool, status FROM voice_tool_calls ORDER BY id`).all() as { call_id: string; tool: string; status: string }[]) {
    toolsByCall.set(t.call_id, [...(toolsByCall.get(t.call_id) ?? []), t.status === "ok" ? t.tool : `${t.tool} (failed)`]);
  }
  const rows = (db.prepare(`SELECT call_id, direction, started_at, ended_at, duration_s, cost_usd, ended_reason, summary, alert_episode_id FROM voice_calls WHERE call_id NOT LIKE 'pending-%' ORDER BY started_at DESC LIMIT 100`).all() as DbCall[]).map(
    (r): CallRowVM => ({
      id: r.call_id,
      at: new Date(r.started_at),
      direction: r.direction,
      durationS: r.duration_s,
      costUsd: r.cost_usd,
      result: resultWords(r.ended_at, r.ended_reason, r.duration_s),
      endedReason: r.ended_reason,
      summary: r.summary,
      alert: r.alert_episode_id !== null,
      tools: [...new Set(toolsByCall.get(r.call_id) ?? [])],
    }),
  );
  const count = (dir?: string) =>
    db.prepare(`SELECT COUNT(*) FROM voice_calls WHERE started_at >= ? AND started_at < ? AND call_id NOT LIKE 'pending-%'${dir ? ` AND direction = '${dir}'` : ""}`).pluck().get(...month) as number;
  const tools = db
    .prepare(
      `SELECT tool, COUNT(*) AS calls, SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS failures FROM voice_tool_calls WHERE ts >= ? AND ts < ? GROUP BY tool ORDER BY calls DESC`,
    )
    .all(...month) as { tool: string; calls: number; failures: number }[];
  return {
    flags,
    spentUsd: b.spent,
    capUsd: b.cap,
    fraction: b.fraction,
    level: b.level,
    callsThisMonth: count(),
    inboundThisMonth: count("inbound"),
    outboundThisMonth: count("outbound"),
    lastCall: rows[0] ?? null,
    tools,
    toolCalls: tools.reduce((n, t) => n + t.calls, 0),
    toolFailures: tools.reduce((n, t) => n + t.failures, 0),
    calls: rows,
    openAlerts: openEpisodes(db).map((e) => ({ kind: e.kind, since: new Date(e.started_at), attemptsToday: e.attempts_today, lastAttemptAt: e.last_attempt_at ? new Date(e.last_attempt_at) : null })),
  };
}

/** The Overview card. Off until it is set up; amber at 80% of the limit or with tool failures; red at the limit. */
export function voiceModule(vm: VoiceVM, jobs: JobVM[]): ModuleStatus {
  const f = vm.flags;
  const issues: string[] = [];
  let state: State = "ok";
  if (!f.enabled) state = "off";
  else if (!f.configured) state = "off";
  else {
    if (vm.level === "capped") {
      state = "error";
      issues.push(`The monthly voice limit is reached ($${vm.spentUsd.toFixed(2)} of $${vm.capUsd.toFixed(0)}): no phone calls, tools refuse`);
    } else if (vm.level === "warn") {
      state = "warn";
      issues.push(`Voice spend is at ${Math.round(vm.fraction * 100)}% of the monthly limit`);
    }
    if (vm.toolFailures > 0) {
      if (state === "ok") state = "warn";
      issues.push(`${vm.toolFailures} voice tool call${vm.toolFailures === 1 ? "" : "s"} failed this month`);
    }
    if (!f.phraseSet) issues.push("No passphrase is set, so voice cannot open the garage (VOICE_OPEN_PHRASE in .env)");
    for (const a of vm.openAlerts) issues.push(`Alert open: ${a.kind.replace("_", " ")} since ${a.since.toISOString().slice(11, 16)}Z, ${a.attemptsToday} call${a.attemptsToday === 1 ? "" : "s"} today`);
  }
  const job = jobs.find((j) => j.name === "voice-alerts");
  const facts: Fact[] = [
    { label: "Spend this month", value: `$${vm.spentUsd.toFixed(2)} of $${vm.capUsd.toFixed(0)}` },
    { label: "Calls this month", value: `${vm.callsThisMonth} (${vm.inboundThisMonth} in, ${vm.outboundThisMonth} out)` },
    { label: "Home Assistant writes", value: f.writesLive ? "live" : "dry run (says what it would do)" },
    { label: "Passphrase", value: f.phraseSet ? "set" : "not set" },
    { label: "Alert watchdog", value: job ? `${job.scheduleHuman}${job.overdue ? ", overdue" : ""}` : "not scheduled" },
  ];
  return {
    key: "voice",
    name: "Voice",
    state,
    mode: f.configured && f.enabled ? (f.writesLive ? "live" : "dry") : undefined,
    summary: !f.enabled ? "Switched off (VOICE_ENABLED=false)" : !f.configured ? "Not set up yet (see the README, Voice)" : `$${vm.spentUsd.toFixed(2)} of $${vm.capUsd.toFixed(0)} this month · ${vm.callsThisMonth} call${vm.callsThisMonth === 1 ? "" : "s"}`,
    lastOkAt: vm.lastCall?.at ?? null,
    link: "/calls",
    issues,
    facts,
  };
}
