import path from "node:path";
import { config } from "../../config";
import { whenLabel, wantsEvent } from "../../plans/actions";
import { loadAllowlist } from "../../plans/allowlist";
import { ALLOWED_BRIDGES } from "../../plans/settings";
import { allPlans, getState, planCode, type Plan } from "../../plans/store";
import { dayKey } from "../../telegram/time";
import { buildAiUsage, type AiUsageVM } from "./ai";
import type { PlanVM, UiContext } from "./types";

// The Plans page (and the Beeper facts the Overview needs). Plans come from plans.md's database.

const BRIDGE_NAMES: Record<string, string> = { instagramgo: "Instagram", whatsapp: "WhatsApp", telegram: "Telegram", slackgo: "Slack", facebookgo: "Messenger" };

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export function toPlanVM(p: Plan, today: string): PlanVM {
  const unreplied = p.replied_at === null && p.my_stance !== "committed" && p.my_stance !== "declined";
  const why = [
    unreplied ? "you haven't replied" : "",
    p.date_certainty === "ambiguous" ? "day is unclear" : "",
    p.possible_link ? `possible link to a message in ${p.possible_link.chat_name} (${Math.round(p.possible_link.confidence * 100)}% sure: ${p.possible_link.evidence})` : "",
  ].filter(Boolean);
  const details = [
    p.what ?? "",
    p.meeting_point ? `Meet: ${p.meeting_point}` : "",
    p.participants.length ? `With: ${p.participants.join(", ")}` : "",
    p.cost ? `Cost: ${p.cost}` : "",
    p.bring ? `Bring: ${p.bring}` : "",
    ...p.notes.map((n) => `Note: ${n}`),
  ].filter(Boolean);
  const dm = p.date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.date) : null;
  void today;
  return {
    id: planCode(p.id),
    title: p.title,
    when: whenLabel(p),
    dayChip: dm ? { day: String(+dm[3]), month: MONTHS[+dm[2] - 1] ?? "" } : null,
    where: p.location,
    chat: [p.source_chat_name, ...p.linked_chats.map((l) => l.name)].join(", "),
    myStance: p.my_stance,
    planStatus: p.plan_status,
    updatedAt: new Date(p.last_updated),
    calendarUrl: p.event_link,
    why,
    details,
    clash: p.cal_state === "clash",
    onCalendar: wantsEvent(p),
    url: p.url,
  };
}

export interface PlansStatusVM {
  beeper: { configured: boolean; connected: boolean; error: string | null; accounts: string | null; lastPollAt: Date | null; baseUrl: string };
  scope: string;
  dryRun: boolean;
  calendarConnected: boolean;
  lastBatchSummary: string | null;
  lastBatchAt: Date | null;
  foundThisWeek: number;
  messagesWaiting: number;
  runError: string | null;
  ai: AiUsageVM;
}

export function buildPlansStatus(ctx: UiContext): PlansStatusVM {
  const { db, now, flags } = ctx;
  const allow = loadAllowlist(path.dirname(config.DB_PATH));
  const networks = ALLOWED_BRIDGES.map((b) => BRIDGE_NAMES[b] ?? b).join(", ");
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const lastPoll = getState(db, "last_poll_ok_at");
  const lastBatch = getState(db, "last_batch_at");
  return {
    beeper: {
      configured: flags.beeperConfigured,
      connected: Boolean(lastPoll) && !getState(db, "last_error"),
      error: getState(db, "last_error"),
      accounts: getState(db, "accounts"),
      lastPollAt: lastPoll ? new Date(lastPoll) : null,
      baseUrl: flags.beeperBaseUrl,
    },
    scope: flags.plansAllChats ? `${networks}, all chats` : `${allow.chats.length} allowlisted chat${allow.chats.length === 1 ? "" : "s"} (${networks})`,
    dryRun: flags.plansDryRun,
    calendarConnected: flags.calendarConnected,
    lastBatchSummary: getState(db, "last_batch_summary"),
    lastBatchAt: lastBatch ? new Date(lastBatch) : null,
    foundThisWeek: (db.prepare(`SELECT COUNT(*) AS n FROM plans WHERE created_at >= ?`).get(weekAgo) as { n: number }).n,
    messagesWaiting: (db.prepare(`SELECT COUNT(*) AS n FROM plan_messages WHERE status = 'pending'`).get() as { n: number }).n,
    runError: getState(db, "last_run_error"),
    ai: buildAiUsage(db, now),
  };
}

export interface WouldVM {
  at: Date;
  plan: string;
  action: string;
  detail: string;
}
export interface PlansVM {
  status: PlansStatusVM;
  needs: PlanVM[];
  clashes: PlanVM[];
  upcoming: PlanVM[];
  proposed: PlanVM[];
  past: PlanVM[];
  would: WouldVM[];
  showWould: boolean;
}

export function buildPlans(ctx: UiContext): PlansVM {
  const { db, now } = ctx;
  const today = dayKey(now);
  const plans = allPlans(db, { includeArchived: true });
  const live = plans.filter((p) => !p.archived_at && p.plan_status !== "cancelled" && p.my_stance !== "declined" && (p.date === null || p.date >= today));
  const unreplied = (p: Plan) => p.replied_at === null && p.my_stance !== "committed" && p.my_stance !== "declined";
  const needs = live.filter((p) => unreplied(p) || (p.my_stance === "committed" && p.date_certainty === "ambiguous") || p.possible_link);
  const clashes = live.filter((p) => p.cal_state === "clash");
  const upcoming = live.filter((p) => p.my_stance === "committed").sort((a, b) => (a.date ?? "9").localeCompare(b.date ?? "9"));
  const proposed = live.filter((p) => p.my_stance !== "committed");
  const past = plans.filter((p) => !live.includes(p));
  const vm = (list: Plan[]) => list.map((p) => toPlanVM(p, today));
  const would = db.prepare(`SELECT plan_id, kind, detail, created_at FROM plan_actions WHERE dry_run = 1 ORDER BY id DESC LIMIT 40`).all() as { plan_id: number; kind: string; detail: string | null; created_at: string }[];
  return {
    status: buildPlansStatus(ctx),
    needs: vm(needs),
    clashes: vm(clashes),
    upcoming: vm(upcoming),
    proposed: vm(proposed),
    past: vm(past),
    would: would.map((w) => ({ at: new Date(w.created_at), plan: planCode(w.plan_id), action: w.kind.replace("would_", "would "), detail: w.detail ?? "" })),
    showWould: ctx.flags.plansDryRun,
  };
}
