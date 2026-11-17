import type Database from "better-sqlite3";
import type { CallInfo, EndReport } from "./vapi";

// The voice_calls and voice_tool_calls tables. Only a summary of a call is kept.

/** +61 405 642 326, 0405642326 and +61405642326 are not all the same string: compare digits only. */
export const digits = (n: string | null | undefined) => (n ?? "").replace(/\D/g, "");
export const samePhone = (a: string | null | undefined, b: string | null | undefined) => digits(a) !== "" && digits(a) === digits(b);

/** "+61 4•• ••• 326": enough to recognise, not enough to dial. */
export const maskPhone = (n: string | null | undefined) => {
  const d = digits(n);
  return d.length < 6 ? "unknown number" : `+${d.slice(0, 2)} ••• ${d.slice(-3)}`;
};

export interface CallRow {
  call_id: string;
  direction: "inbound" | "outbound";
  started_at: string;
  ended_at: string | null;
  duration_s: number | null;
  cost_usd: number | null;
  ended_reason: string | null;
  summary: string | null;
  caller: string | null;
  alert_episode_id: number | null;
}

export const getCall = (db: Database.Database, id: string) => db.prepare(`SELECT * FROM voice_calls WHERE call_id = ?`).get(id) as CallRow | undefined;

/** Register a call Jarvis has accepted. Safe to call twice. */
export function registerCall(db: Database.Database, call: { id: string; direction: "inbound" | "outbound"; number: string | null; alertEpisodeId?: number }, now: Date): void {
  db.prepare(`INSERT OR IGNORE INTO voice_calls (call_id, direction, started_at, caller, alert_episode_id) VALUES (?, ?, ?, ?, ?)`).run(
    call.id,
    call.direction,
    now.toISOString(),
    call.number,
    call.alertEpisodeId ?? null,
  );
}

/**
 * Is this call one Jarvis knows? Known calls (outbound ones Jarvis started, inbound ones it accepted) are fine. A call it has
 * not seen is accepted only if it is an inbound call from my own number; anything else is refused.
 */
export function acceptCall(db: Database.Database, call: CallInfo | null, ownerPhone: string | undefined, now: Date): boolean {
  if (!call) return false;
  if (getCall(db, call.id)) return true;
  if (call.direction === "inbound" && samePhone(call.number, ownerPhone)) {
    registerCall(db, { id: call.id, direction: "inbound", number: call.number }, now);
    return true;
  }
  return false;
}

export function logToolCall(db: Database.Database, callId: string, tool: string, status: "ok" | "error", durationMs: number, args: unknown, now: Date): void {
  const names = args && typeof args === "object" && !Array.isArray(args) ? Object.keys(args as object).join(",") : null;
  db.prepare(`INSERT INTO voice_tool_calls (call_id, tool, status, duration_ms, ts, arg_names) VALUES (?, ?, ?, ?, ?, ?)`).run(callId, tool, status, Math.round(durationMs), now.toISOString(), names);
}

/** One plain line about the call, made by Jarvis from what it did (the tools run and how it ended). No transcript is involved. */
export function composeSummary(db: Database.Database, call: CallRow, reason: string | null): string {
  const tools = (db.prepare(`SELECT tool, status FROM voice_tool_calls WHERE call_id = ? ORDER BY id`).all(call.call_id) as { tool: string; status: string }[]).map((t) => (t.status === "ok" ? t.tool : `${t.tool} (failed)`));
  const used = tools.length ? `used ${[...new Set(tools)].join(", ")}` : "no tools used";
  return `${call.direction === "inbound" ? "You called Jarvis" : "Jarvis called you"}: ${used}${reason ? `; ended: ${reason}` : ""}.`;
}

/** The end-of-call report: close the call, with its cost and a summary. Returns the finished row. */
export function finishCall(db: Database.Database, callId: string, report: EndReport, now: Date): CallRow | undefined {
  const call = getCall(db, callId);
  if (!call) return undefined;
  const ended = report.endedAt ?? now.toISOString();
  const started = report.startedAt ?? call.started_at;
  const seconds = Math.max(0, Math.round((Date.parse(ended) - Date.parse(started)) / 1000));
  db.prepare(`UPDATE voice_calls SET ended_at = ?, duration_s = ?, cost_usd = COALESCE(?, cost_usd), ended_reason = ?, summary = ? WHERE call_id = ?`).run(
    ended,
    Number.isFinite(seconds) ? seconds : null,
    report.cost,
    report.endedReason,
    composeSummary(db, call, report.endedReason),
    callId,
  );
  return getCall(db, callId);
}
