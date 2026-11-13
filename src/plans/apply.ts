import type Database from "better-sqlite3";
import { zoned } from "../telegram/time";
import type { DetectionResult } from "./detect";
import {
  LINK_HIGH,
  LINK_OUTSIDER,
  LINK_POSSIBLE,
  LINK_SAME_DAY_HIGH,
  MAX_DATE_FUTURE_DAYS,
  MAX_DATE_PAST_DAYS,
  MAX_RESULTS_PER_BATCH,
  MIN_CREATE_CONFIDENCE,
} from "./settings";
import {
  addHistory,
  addStance,
  allPlans,
  getPlan,
  insertPlan,
  parsePlanCode,
  updatePlan,
  type Plan,
  type PlanStatus,
} from "./store";

// This is where model output becomes plan data, and it is plain code. The model's answer is
// untrusted: every field is checked and clipped, evidence must point at real messages in THIS
// batch, and my stance only ever comes from messages that I (ME) actually wrote.

export interface BatchMessage {
  id: string;
  senderId: string;
  isMe: boolean;
  ts: string;
  kind: "text" | "reaction";
}
export interface BatchContext {
  chatId: string;
  chatName: string;
  messages: Map<string, BatchMessage>;
  now: Date;
}
export interface ApplyReport {
  created: number[];
  updated: number[];
  linked: number[];
  possibleLinks: number[];
  rejected: string[];
}

// ---------------------------------------------------------------- checking single fields
const clean = (s: string | null | undefined, max: number): string | null => {
  const t = (s ?? "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max);
  return t || null;
};

/** A real calendar day (YYYY-MM-DD) within the allowed range around today (Sydney), else null. */
export function checkDate(value: string | null | undefined, now: Date): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value ?? "").trim());
  if (!m) return null;
  const check = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (check.getUTCMonth() !== +m[2] - 1 || check.getUTCDate() !== +m[3]) return null;
  const z = zoned(now);
  const day = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const today = Date.UTC(z.year, z.month - 1, z.day);
  const diffDays = Math.round((day - today) / 86_400_000);
  return diffDays < -MAX_DATE_PAST_DAYS || diffDays > MAX_DATE_FUTURE_DAYS ? null : value!.trim();
}
export function checkTime(value: string | null | undefined): string | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((value ?? "").trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}
function checkUrl(value: string | null | undefined): string | null {
  try {
    const u = new URL((value ?? "").trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString().slice(0, 300) : null;
  } catch {
    return null;
  }
}

interface Fields {
  title: string | null;
  what: string | null;
  date: string | null;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  meeting_point: string | null;
  participants: string[];
  cost: string | null;
  bring: string | null;
  url: string | null;
  notes: string[];
  plan_status: PlanStatus | null;
  confidence: number;
}

export function sanitise(r: DetectionResult, now: Date): Fields {
  const start = checkTime(r.start_time);
  let end = checkTime(r.end_time);
  if (start && end && end <= start) end = null;
  return {
    title: clean(r.title ?? r.what, 100),
    what: clean(r.what, 200),
    date: checkDate(r.date, now),
    start_time: start,
    end_time: end,
    location: clean(r.location, 150),
    meeting_point: clean(r.meeting_point, 150),
    participants: (r.participants ?? []).map((p) => clean(p, 40)).filter((p): p is string => !!p).slice(0, 20),
    cost: clean(r.cost, 80),
    bring: clean(r.bring, 150),
    url: checkUrl(r.url),
    notes: (r.notes ?? []).map((n) => clean(n, 200)).filter((n): n is string => !!n).slice(0, 8),
    plan_status: r.plan_status ?? null,
    confidence: Math.min(1, Math.max(0, Number.isFinite(r.confidence) ? (r.confidence as number) : 0)),
  };
}

// ---------------------------------------------------------------- linking
const isOpen = (p: Plan) => p.archived_at === null && p.plan_status !== "cancelled";
const inChat = (p: Plan, chatId: string) => p.source_chat_id === chatId || p.linked_chats.some((c) => c.id === chatId);

function senderIsInChat(db: Database.Database, chatId: string, senderId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM plan_members WHERE chat_id = ? AND user_id = ?`).get(chatId, senderId);
}

type LinkDecision = "same-chat" | "link" | "possible" | "no";

/** Should a message in this chat be treated as being about `plan`, which lives in other chats? */
function decideLink(db: Database.Database, ctx: BatchContext, plan: Plan, r: DetectionResult, evidence: string[]): LinkDecision {
  if (inChat(plan, ctx.chatId)) return "same-chat";
  const confidence = r.link_confidence ?? 0;
  if (!(confidence >= LINK_POSSIBLE) || !isOpen(plan)) return "no";
  if (confidence < LINK_HIGH) return "possible";
  // Two plans on the same day: only a very sure link is acted on, else it is only a "possible" one.
  const sameDay = plan.date ? allPlans(db).filter((o) => o.id !== plan.id && isOpen(o) && o.date === plan.date).length : 0;
  if (sameDay > 0 && confidence < LINK_SAME_DAY_HIGH) return "possible";
  // The sender should be in the plan's own chat; a stranger needs a much surer link.
  const senders = evidence.map((id) => ctx.messages.get(id)).filter((m) => m && !m.isMe).map((m) => m!.senderId);
  const insider = senders.some((s) => senderIsInChat(db, plan.source_chat_id, s));
  if (!insider && confidence < LINK_OUTSIDER) return "possible";
  return "link";
}

function setPossibleLink(db: Database.Database, ctx: BatchContext, plan: Plan, r: DetectionResult, evidence: string[]): void {
  updatePlan(
    db,
    plan.id,
    {
      possible_link: {
        chat_id: ctx.chatId,
        chat_name: ctx.chatName,
        message_id: evidence[0] ?? "",
        confidence: Math.round((r.link_confidence ?? 0) * 100) / 100,
        evidence: clean(r.link_evidence, 150) ?? "",
      },
    },
    ctx.now,
  );
}

// ---------------------------------------------------------------- applying
export function applyResults(db: Database.Database, ctx: BatchContext, results: DetectionResult[]): ApplyReport {
  const report: ApplyReport = { created: [], updated: [], linked: [], possibleLinks: [], rejected: [] };
  let creates = 0;
  for (const r of results.slice(0, MAX_RESULTS_PER_BATCH)) {
    try {
      db.transaction(() => applyOne(db, ctx, r, report, () => creates++ < MAX_RESULTS_PER_BATCH))();
    } catch (err) {
      report.rejected.push(`error: ${(err as Error).message}`);
    }
  }
  return report;
}

function applyOne(db: Database.Database, ctx: BatchContext, r: DetectionResult, report: ApplyReport, mayCreate: () => boolean): void {
  if (r.action === "none") return;
  const evidence = (r.evidence_message_ids ?? []).filter((id) => ctx.messages.has(id));
  const fields = sanitise(r, ctx.now);

  // Which plan is this about?
  const refCode = r.plan_id ?? r.linked_plan_id;
  const refId = refCode ? parsePlanCode(refCode) : null;
  const ref = refId !== null ? getPlan(db, refId) : undefined;
  const refPlan = ref && ref.archived_at === null ? ref : undefined;

  let plan: Plan | undefined;
  if (refPlan) {
    const decision = decideLink(db, ctx, refPlan, r, evidence);
    if (decision === "no") {
      if (r.action === "update") return void report.rejected.push(`${refCode}: no link`);
    } else if (decision === "possible") {
      setPossibleLink(db, ctx, refPlan, r, evidence);
      report.possibleLinks.push(refPlan.id);
      if (r.action === "update") return; // low confidence: only noted, nothing else happens
    } else {
      plan = refPlan;
      if (decision === "link") {
        updatePlan(db, plan.id, { linked_chats: [...plan.linked_chats, { id: ctx.chatId, name: ctx.chatName }], possible_link: null }, ctx.now);
        addHistory(db, plan.id, `linked chat ${ctx.chatName}`, ctx.now);
        report.linked.push(plan.id);
        plan = getPlan(db, plan.id)!;
      }
    }
  } else if (r.action === "update") {
    return void report.rejected.push("update of an unknown plan");
  }

  if (!plan && r.action === "create") {
    // The same plan seen again in this chat: update it instead of making a second one.
    const same = fields.date
      ? allPlans(db).find((p) => isOpen(p) && inChat(p, ctx.chatId) && p.date === fields.date && p.title.toLowerCase() === (fields.title ?? "").toLowerCase())
      : undefined;
    if (same) plan = same;
    else {
      const early = evidence.map((id) => ctx.messages.get(id)!.ts).sort()[0];
      if (!fields.title || fields.confidence < MIN_CREATE_CONFIDENCE) return void report.rejected.push("create: no title or low confidence");
      if (evidence.length === 0) return void report.rejected.push("create: no evidence");
      if (r.date && !fields.date) return void report.rejected.push("create: date out of range");
      if (!mayCreate()) return void report.rejected.push("create: too many in one batch");
      const id = insertPlan(
        db,
        {
          title: fields.title,
          what: fields.what,
          date: fields.date,
          start_time: fields.start_time,
          end_time: fields.end_time,
          location: fields.location,
          meeting_point: fields.meeting_point,
          participants: fields.participants,
          cost: fields.cost,
          bring: fields.bring,
          url: fields.url,
          notes: fields.notes,
          plan_status: fields.plan_status ?? "proposed",
          date_certainty: fields.date && r.date_certainty !== "ambiguous" ? "exact" : "ambiguous",
          confidence: fields.confidence,
          source_chat_id: ctx.chatId,
          source_chat_name: ctx.chatName,
          source_message_ids: evidence,
          raised_at: early,
        },
        ctx.now,
      );
      plan = getPlan(db, id)!;
      report.created.push(id);
      // A low-confidence match to a plan elsewhere is only noted on that plan.
      if (refPlan && !inChat(refPlan, ctx.chatId) && (r.link_confidence ?? 0) >= LINK_POSSIBLE) {
        setPossibleLink(db, ctx, refPlan, r, evidence);
        report.possibleLinks.push(refPlan.id);
      }
    }
  }
  if (!plan) return;

  if (!report.created.includes(plan.id)) mergeUpdate(db, ctx, plan, fields, r, evidence, report);
  applyStance(db, ctx, plan.id, r, evidence);
  markReplied(db, ctx, plan.id, r);
}

function mergeUpdate(db: Database.Database, ctx: BatchContext, plan: Plan, f: Fields, r: DetectionResult, evidence: string[], report: ApplyReport): void {
  const changes: Partial<Plan> = {};
  const notes: string[] = [];
  const set = <K extends keyof Plan>(key: K, value: Plan[K] | null, label?: string) => {
    if (value === null || value === undefined || value === plan[key]) return;
    changes[key] = value;
    if (label) notes.push(`${label}: ${plan[key] ?? "?"} -> ${value}`);
  };
  set("date", f.date, "date");
  set("start_time", f.start_time, "time");
  set("end_time", f.end_time);
  set("location", f.location, "place");
  set("plan_status", f.plan_status, "status");
  set("what", f.what);
  set("meeting_point", f.meeting_point);
  set("cost", f.cost);
  set("bring", f.bring);
  set("url", f.url);
  if (f.title && !plan.title) changes.title = f.title;
  if (f.participants.length) changes.participants = [...new Set([...plan.participants, ...f.participants])].slice(0, 30);
  if (f.notes.length) changes.notes = [...new Set([...plan.notes, ...f.notes])].slice(-20);
  if (f.date) changes.date_certainty = "exact";
  else if (r.date_certainty === "ambiguous" && !plan.date) changes.date_certainty = "ambiguous";
  if (f.confidence > 0) changes.confidence = f.confidence;
  if (evidence.length) changes.source_message_ids = [...new Set([...plan.source_message_ids, ...evidence])].slice(-50);
  if (Object.keys(changes).length === 0) return;
  updatePlan(db, plan.id, changes, ctx.now);
  for (const n of notes) addHistory(db, plan.id, n, ctx.now);
  if (!report.updated.includes(plan.id) && notes.length) report.updated.push(plan.id);
}

/** My stance changes only on an explicit statement, written by me, in this batch. */
function applyStance(db: Database.Database, ctx: BatchContext, planId: number, r: DetectionResult, evidence: string[]): void {
  const stance = r.my_stance;
  if (r.stance_changed !== true || (stance !== "committed" && stance !== "declined" && stance !== "unsure")) return;
  const msg = r.stance_evidence_message_id ? ctx.messages.get(r.stance_evidence_message_id) : undefined;
  if (!msg || !msg.isMe || !evidence.concat(r.stance_evidence_message_id!).includes(msg.id)) return;
  addStance(db, planId, { stance, message_id: msg.id, chat_id: ctx.chatId, ts: msg.ts }, ctx.now);
}

/**
 * "I have replied about this plan." The model's word is not enough: there must really be a message
 * or reaction from me in one of the plan's chats since the plan was raised. Enquiring ("what time?")
 * counts, and so does an explicit yes or no. A "maybe" does not (it still gets one ping).
 */
function markReplied(db: Database.Database, ctx: BatchContext, planId: number, r: DetectionResult): void {
  const plan = getPlan(db, planId)!;
  if (plan.replied_at) return;
  const claimed = r.my_reply_about_plan === "yes" || r.my_stance === "enquiring" || plan.my_stance === "committed" || plan.my_stance === "declined";
  if (!claimed) return;
  const chats = [plan.source_chat_id, ...plan.linked_chats.map((c) => c.id)];
  const inBatch = [...ctx.messages.values()].some((m) => m.isMe && chats.includes(ctx.chatId) && m.ts >= plan.raised_at);
  const before = db
    .prepare(`SELECT 1 FROM plan_messages WHERE is_me = 1 AND ts >= ? AND chat_id IN (${chats.map(() => "?").join(",")}) LIMIT 1`)
    .get(plan.raised_at, ...chats);
  if (inBatch || before) updatePlan(db, planId, { replied_at: ctx.now.toISOString() }, ctx.now);
}

