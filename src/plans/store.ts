import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { formatWhen } from "../telegram/time";

// Plain reading and writing of the plans tables. No decisions are made here.

export type Stance = "none" | "committed" | "declined" | "unsure";
export type PlanStatus = "proposed" | "confirmed" | "cancelled";
export type CalState = "none" | "created" | "clash" | "suppressed" | "removed";

export interface PossibleLink {
  chat_id: string;
  chat_name: string;
  message_id: string;
  confidence: number;
  evidence: string;
}
export interface Plan {
  id: number;
  title: string;
  what: string | null;
  date: string | null; // YYYY-MM-DD, Sydney
  start_time: string | null; // HH:MM
  end_time: string | null;
  location: string | null;
  meeting_point: string | null;
  participants: string[];
  cost: string | null;
  bring: string | null;
  url: string | null;
  notes: string[];
  plan_status: PlanStatus;
  my_stance: Stance;
  date_certainty: "exact" | "ambiguous";
  confidence: number;
  source_chat_id: string;
  source_chat_name: string;
  linked_chats: { id: string; name: string }[];
  possible_link: PossibleLink | null;
  source_message_ids: string[];
  history: string[];
  raised_at: string;
  created_at: string;
  last_updated: string;
  replied_at: string | null;
  event_id: string | null;
  event_link: string | null;
  event_version: string | null;
  cal_state: CalState;
  cal_state_version: string | null;
  last_pinged_at: string | null;
  archived_at: string | null;
}
export interface StanceEntry {
  id: number;
  stance: Exclude<Stance, "none">;
  message_id: string;
  chat_id: string;
  ts: string;
}

const JSON_FIELDS = ["participants", "notes", "linked_chats", "source_message_ids", "history"] as const;

export const planCode = (id: number) => `P-${String(id).padStart(4, "0")}`;
export function parsePlanCode(text: string): number | null {
  const m = /^P-(\d{1,6})$/i.exec(text.trim());
  return m ? Number(m[1]) : null;
}

// ---- state (key/value)
export function getState(db: Database.Database, key: string): string | null {
  return (db.prepare(`SELECT value FROM plans_state WHERE key = ?`).get(key) as { value: string | null } | undefined)?.value ?? null;
}
export function setState(db: Database.Database, key: string, value: string | null, now = new Date()): void {
  db.prepare(
    `INSERT INTO plans_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now.toISOString());
}

// ---- plans
function rowToPlan(row: Record<string, unknown>): Plan {
  const plan = { ...row } as Record<string, unknown>;
  for (const f of JSON_FIELDS) plan[f] = JSON.parse(String(row[f] ?? "[]"));
  plan.possible_link = row.possible_link ? JSON.parse(String(row.possible_link)) : null;
  return plan as unknown as Plan;
}
export function getPlan(db: Database.Database, id: number): Plan | undefined {
  const row = db.prepare(`SELECT * FROM plans WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToPlan(row) : undefined;
}
export function allPlans(db: Database.Database, opts: { includeArchived?: boolean } = {}): Plan[] {
  const rows = db
    .prepare(`SELECT * FROM plans ${opts.includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY id`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToPlan);
}

/** Write the given fields of a plan. Lists and objects are stored as JSON. */
export function updatePlan(db: Database.Database, id: number, fields: Partial<Plan>, now = new Date()): void {
  const entries = Object.entries({ ...fields, last_updated: fields.last_updated ?? now.toISOString() });
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  const values = entries.map(([k, v]) =>
    (JSON_FIELDS as readonly string[]).includes(k) || k === "possible_link" ? (v === null ? null : JSON.stringify(v)) : v,
  );
  db.prepare(`UPDATE plans SET ${sets} WHERE id = ?`).run(...(values as never[]), id);
}

export type NewPlan = Pick<Plan, "title" | "plan_status" | "source_chat_id" | "source_chat_name" | "raised_at"> &
  Partial<Pick<Plan, "what" | "date" | "start_time" | "end_time" | "location" | "meeting_point" | "participants" | "cost" | "bring" | "url" | "notes" | "date_certainty" | "confidence" | "source_message_ids">>;

export function insertPlan(db: Database.Database, p: NewPlan, now = new Date()): number {
  const at = now.toISOString();
  return Number(
    db
      .prepare(
        `INSERT INTO plans (title, what, date, start_time, end_time, location, meeting_point, participants, cost, bring, url, notes,
                            plan_status, date_certainty, confidence, source_chat_id, source_chat_name, source_message_ids,
                            history, raised_at, created_at, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.title, p.what ?? null, p.date ?? null, p.start_time ?? null, p.end_time ?? null, p.location ?? null,
        p.meeting_point ?? null, JSON.stringify(p.participants ?? []), p.cost ?? null, p.bring ?? null, p.url ?? null,
        JSON.stringify(p.notes ?? []), p.plan_status, p.date_certainty ?? "exact", p.confidence ?? 0,
        p.source_chat_id, p.source_chat_name, JSON.stringify(p.source_message_ids ?? []),
        JSON.stringify([`created (${formatWhen(now, now)})`]), p.raised_at, at, at,
      ).lastInsertRowid,
  );
}

export function addHistory(db: Database.Database, id: number, line: string, now = new Date()): void {
  const plan = getPlan(db, id);
  if (!plan) return;
  updatePlan(db, id, { history: [...plan.history, `${line} (${formatWhen(now, now)})`].slice(-30) }, now);
}

/** What counts as "the plan changed in a way worth telling me again": when, where, or its status. */
export function planVersion(p: Pick<Plan, "date" | "start_time" | "end_time" | "location" | "plan_status">): string {
  return createHash("sha1").update(JSON.stringify([p.date, p.start_time, p.end_time, p.location, p.plan_status])).digest("hex").slice(0, 8);
}
/** What is on the calendar event: the same, plus the title. */
export function eventVersion(p: Plan): string {
  return createHash("sha1").update(JSON.stringify([p.title, p.date, p.start_time, p.end_time, p.location, p.what, p.meeting_point, p.cost, p.bring, p.url, p.notes])).digest("hex").slice(0, 8);
}

// ---- my stance over time
export function stanceTimeline(db: Database.Database, planId: number): StanceEntry[] {
  return db.prepare(`SELECT id, stance, message_id, chat_id, ts FROM plan_stances WHERE plan_id = ? ORDER BY ts, id`).all(planId) as StanceEntry[];
}

/**
 * Add one explicit statement of mine ("I'm in", "can't make it", "maybe") at the time of the
 * message it came from, then work out the current stance: the LATEST by message time, whatever
 * order the messages were processed in. Returns true if the stance changed.
 */
export function addStance(
  db: Database.Database,
  planId: number,
  entry: { stance: Exclude<Stance, "none">; message_id: string; chat_id: string; ts: string },
  now = new Date(),
): boolean {
  db.prepare(`INSERT OR IGNORE INTO plan_stances (plan_id, stance, message_id, chat_id, ts, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    planId, entry.stance, entry.message_id, entry.chat_id, entry.ts, now.toISOString(),
  );
  return recomputeStance(db, planId, now);
}

export function recomputeStance(db: Database.Database, planId: number, now = new Date()): boolean {
  const plan = getPlan(db, planId);
  const timeline = stanceTimeline(db, planId);
  const latest = timeline[timeline.length - 1];
  if (!plan || !latest || latest.stance === plan.my_stance) return false;
  updatePlan(db, planId, {
    my_stance: latest.stance,
    // Changing my mind lifts an earlier "Undo": the plan may go back on the calendar.
    cal_state: plan.cal_state === "suppressed" ? "none" : plan.cal_state,
    history: [...plan.history, `${plan.my_stance === "none" ? "stance" : plan.my_stance} -> ${latest.stance} (${formatWhen(new Date(latest.ts), now)})`].slice(-30),
  }, now);
  return true;
}

// ---- actions (idempotency)
/** Record an action. Returns false if this exact action (plan, kind, key) was already recorded. */
export function recordAction(
  db: Database.Database,
  planId: number,
  kind: string,
  key: string,
  detail: string | null,
  dryRun: boolean,
  now = new Date(),
): boolean {
  return (
    db
      .prepare(`INSERT OR IGNORE INTO plan_actions (plan_id, kind, key, dry_run, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(planId, kind, key, dryRun ? 1 : 0, detail, now.toISOString()).changes > 0
  );
}
