import type Database from "better-sqlite3";
import { oneLine } from "../telegram/format";
import type { Outbox } from "../telegram/outbox";
import { dayKey, dayLabel, formatClock, startOfDay, zonedTime, zoned } from "../telegram/time";
import type { BusyEvent, CalendarClient } from "./calendar";
import {
  CALENDAR_CREATES_PER_DAY,
  CALENDAR_MIN_CONFIDENCE,
  COOLDOWN_CALENDAR_MS,
  DEFAULT_EVENT_HOURS,
} from "./settings";
import {
  addStance,
  allPlans,
  eventVersion,
  getPlan,
  planCode,
  planVersion,
  recordAction,
  stanceTimeline,
  updatePlan,
  type Plan,
} from "./store";

// What Jarvis DOES about a plan: calendar events and Telegram pings. Plain code, driven only by the
// plan's stored state. Everything is idempotent: running this again, or after a restart, never
// creates, deletes or pings twice (plan_actions has UNIQUE(plan, kind, key), and a calendar event
// made by Jarvis can always be found again by its jarvis_plan_id).
//
// In dry run nothing leaves the building: no calendar calls that change anything, no pings. Each
// thing that WOULD have happened is recorded in plan_actions (dry_run = 1) and shown on /plans.
//
// There are no buttons (Beeper does not show them): messages end with a /command to type instead.

export interface ActionDeps {
  db: Database.Database;
  calendar: CalendarClient | null;
  notify: Outbox["notify"];
  dryRun: boolean;
  now: Date;
  log: (m: string) => void;
}
export interface ActionSummary {
  created: number;
  updated: number;
  removed: number;
  pinged: number;
  clashes: number;
  would: number;
  errors: string[];
}

// ---------------------------------------------------------------- small helpers
/** The Sydney date + HH:MM as an exact instant. */
function instant(date: string, time: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return zonedTime(y, m, d, hh * 60 + mm);
}
export function eventTimes(p: Plan): { start: Date; end: Date } | null {
  if (!p.date || !p.start_time) return null;
  const start = instant(p.date, p.start_time);
  const end = p.end_time ? instant(p.date, p.end_time) : new Date(start.getTime() + DEFAULT_EVENT_HOURS * 3_600_000);
  return { start, end: end > start ? end : new Date(start.getTime() + DEFAULT_EVENT_HOURS * 3_600_000) };
}
/** "Sat 14 Nov, 7:00pm" (or just the day when there is no time). */
export function whenLabel(p: Plan): string {
  if (!p.date) return "no date yet";
  const noon = instant(p.date, "12:00");
  const day = dayLabel(noon);
  return p.start_time ? `${day}, ${formatClock(instant(p.date, p.start_time))}` : day;
}
const isPast = (p: Plan, now: Date) => {
  const z = zoned(now);
  const today = dayKey(new Date(startOfDay(z.year, z.month, z.day).getTime() + 12 * 3_600_000));
  return p.date !== null && p.date < today;
};

/** Everything needed for a calendar event: committed, confirmed, an exact day AND time, sure enough. */
export function wantsEvent(p: Plan): boolean {
  return p.my_stance === "committed" && p.plan_status === "confirmed" && p.date_certainty === "exact" && !!p.date && !!p.start_time && p.confidence >= CALENDAR_MIN_CONFIDENCE;
}

function eventInput(p: Plan) {
  const t = eventTimes(p)!;
  const lines = [`Created by Jarvis from ${p.source_chat_name}`];
  if (p.what) lines.push(p.what);
  if (p.meeting_point) lines.push(`Meeting point: ${p.meeting_point}`);
  if (p.cost) lines.push(`Cost: ${p.cost}`);
  if (p.bring) lines.push(`Bring: ${p.bring}`);
  if (p.url) lines.push(p.url);
  for (const n of p.notes) lines.push(`- ${n}`);
  return { planId: planCode(p.id), title: p.title, description: lines.join("\n"), location: p.location, startIso: t.start.toISOString(), endIso: t.end.toISOString() };
}

const describe = (p: Plan) => `${oneLine(p.title, 80)}, ${whenLabel(p)}`;

// ---------------------------------------------------------------- the actions
export async function createEventNow(deps: ActionDeps, plan: Plan, opts: { force: boolean }): Promise<"created" | "clash" | "capped" | "adopted" | "no_calendar" | "would"> {
  const { db, calendar, now } = deps;
  const pid = planCode(plan.id);
  if (deps.dryRun) {
    if (recordAction(db, plan.id, "would_create", eventVersion(plan), describe(plan), true, now)) deps.log(`would add to calendar: ${describe(plan)} (${pid})`);
    return "would";
  }
  if (!calendar) return "no_calendar";

  const z = zoned(now);
  const todayStart = startOfDay(z.year, z.month, z.day).toISOString();
  const made = (db.prepare(`SELECT COUNT(*) FROM plan_actions WHERE kind = 'create' AND dry_run = 0 AND created_at >= ?`).pluck().get(todayStart) as number) ?? 0;
  if (made >= CALENDAR_CREATES_PER_DAY) {
    deps.notify(`⚠️ Calendar limit reached (${CALENDAR_CREATES_PER_DAY} new events a day). I did not add: ${describe(plan)} (${pid}).`, {
      dedupeKey: `calendar-cap-${dayKey(now)}`,
      cooldownMs: 24 * 3_600_000,
      canWait: true,
    });
    return "capped";
  }

  // A restart may have happened after the event was made but before it was saved: look first.
  const existing = await calendar.findByPlan(pid);
  if (existing) {
    updatePlan(db, plan.id, { event_id: existing.id, event_link: existing.link, event_version: eventVersion(plan), cal_state: "created" }, now);
    return "adopted";
  }

  const input = eventInput(plan);
  if (!opts.force) {
    const clashes = await calendar.overlapping(input.startIso, input.endIso, pid);
    if (clashes.length) {
      const v = planVersion(plan);
      updatePlan(db, plan.id, { cal_state: "clash", cal_state_version: v }, now);
      if (recordAction(db, plan.id, "clash", v, clashes.map((c) => c.summary).join("; ").slice(0, 300), false, now)) {
        deps.notify(clashText(plan, clashes), { kind: "plan", ref: pid, canWait: true });
      }
      return "clash";
    }
  }

  const ev = await calendar.create(input);
  recordAction(db, plan.id, "create", `${now.toISOString()}:${ev.id}`, ev.id, false, now);
  updatePlan(db, plan.id, { event_id: ev.id, event_link: ev.link, event_version: eventVersion(plan), cal_state: "created" }, now);
  deps.notify(`Added ${describe(plan)}${plan.location ? ` at ${oneLine(plan.location, 60)}` : ""} to your calendar (from ${oneLine(plan.source_chat_name, 40)}).\nWrong? Reply /undo ${pid}`, { kind: "plan", ref: pid, canWait: true });
  return "created";
}

function clashText(plan: Plan, clashes: BusyEvent[]): string {
  const list = clashes.slice(0, 3).map((c) => `- ${oneLine(c.summary, 60)} (${formatClock(new Date(c.startIso))}-${formatClock(new Date(c.endIso))}, ${oneLine(c.calendar, 30)})`).join("\n");
  return `${describe(plan)} clashes with:\n${list}\nI have NOT added it. To add it anyway reply /addanyway ${planCode(plan.id)}`;
}

/** Delete the event if (and only if) Jarvis made it. Clears the plan's link to it either way. */
export async function removeEventNow(deps: ActionDeps, plan: Plan, why: "declined" | "cancelled" | "undo" | "remove"): Promise<boolean> {
  const { db, calendar, now } = deps;
  if (!plan.event_id) return false;
  if (deps.dryRun) {
    if (recordAction(db, plan.id, "would_remove", plan.event_id, why, true, now)) deps.log(`would remove from calendar (${why}): ${describe(plan)}`);
    return false;
  }
  if (!calendar) return false;
  const removed = await calendar.removeIfOurs(plan.event_id, planCode(plan.id));
  updatePlan(db, plan.id, { event_id: null, event_link: null, event_version: null, cal_state: why === "undo" ? "suppressed" : "removed" }, now);
  if (removed) recordAction(db, plan.id, "remove", `${now.toISOString()}:${plan.event_id}`, why, false, now);
  return removed;
}

// ---------------------------------------------------------------- one plan
async function handlePlan(deps: ActionDeps, plan: Plan, sum: ActionSummary): Promise<void> {
  const { db, now } = deps;
  const pid = planCode(plan.id);
  if (isPast(plan, now)) return;

  // Called off: take Jarvis's event away and say so.
  if (plan.plan_status === "cancelled") {
    if (plan.event_id && (await removeEventNow(deps, plan, "cancelled"))) {
      sum.removed++;
      deps.notify(`${describe(plan)} was cancelled, so I removed it from your calendar.`, { kind: "plan", ref: pid, canWait: true });
    }
    return;
  }
  // I said no: remove it, offer to put it back, and never ping about it.
  if (plan.my_stance === "declined") {
    if (plan.event_id && (await removeEventNow(deps, plan, "declined"))) {
      sum.removed++;
      deps.notify(`You declined ${describe(plan)}, so I removed it from your calendar.\nChanged your mind? Reply /addback ${pid}`, { kind: "plan", ref: pid, canWait: true });
    }
    return;
  }

  // I said "maybe" after it was added: keep it, but ask.
  if (plan.my_stance === "unsure" && plan.event_id) {
    const latest = stanceTimeline(db, plan.id).at(-1)!;
    if (recordAction(db, plan.id, deps.dryRun ? "would_ask_keep" : "ask_keep", String(latest.id), null, deps.dryRun, now)) {
      if (deps.dryRun) {
        deps.log(`would ask whether to keep: ${describe(plan)}`);
        sum.would++;
      } else {
        deps.notify(`You said maybe about ${describe(plan)}, which is on your calendar.\nReply /keep ${pid} or /remove ${pid}`, { kind: "plan", ref: pid, canWait: true });
      }
    }
  }

  // The calendar.
  if (plan.event_id) {
    if (wantsEvent(plan) && plan.event_version !== eventVersion(plan)) {
      if (deps.dryRun) {
        if (recordAction(db, plan.id, "would_update", eventVersion(plan), describe(plan), true, now)) {
          deps.log(`would update calendar event: ${describe(plan)}`);
          sum.would++;
        }
      } else if (deps.calendar) {
        const ev = await deps.calendar.update(plan.event_id, eventInput(plan));
        updatePlan(db, plan.id, { event_link: ev.link, event_version: eventVersion(plan) }, now);
        recordAction(db, plan.id, "update", `${eventVersion(plan)}`, null, false, now);
        sum.updated++;
        deps.notify(`Updated on your calendar: ${describe(plan)}${plan.location ? ` at ${oneLine(plan.location, 60)}` : ""}.`, { kind: "plan", ref: pid, canWait: true });
      }
    }
  } else if (wantsEvent(plan) && plan.cal_state !== "suppressed" && !(plan.cal_state === "clash" && plan.cal_state_version === planVersion(plan))) {
    const outcome = await createEventNow(deps, plan, { force: false });
    if (outcome === "created") sum.created++;
    else if (outcome === "clash") sum.clashes++;
    else if (outcome === "would") sum.would++;
    else if (outcome === "no_calendar") sum.errors.push("Google Calendar is not connected (log in at /calendar/login)");
  }

  // A confirmed plan I committed to, but the day is unclear: ask me to check.
  const v = planVersion(plan);
  if (plan.my_stance === "committed" && plan.plan_status === "confirmed" && (plan.date_certainty === "ambiguous" || !plan.date)) {
    if (recordAction(db, plan.id, deps.dryRun ? "would_ping_date" : "ping_date", v, null, deps.dryRun, now)) {
      if (deps.dryRun) {
        deps.log(`would ask you to check the date: ${oneLine(plan.title, 60)}`);
        sum.would++;
      } else {
        deps.notify(`${oneLine(plan.title, 80)} (from ${oneLine(plan.source_chat_name, 40)}) looks confirmed, but I can't tell which day it is. Please check the chat. (${pid})`, { kind: "plan", ref: pid, canWait: true });
        sum.pinged++;
      }
    }
  }

  // One ping per plan version if I have not replied.
  if (plan.replied_at === null && plan.my_stance !== "committed") {
    if (recordAction(db, plan.id, deps.dryRun ? "would_ping" : "ping", v, null, deps.dryRun, now)) {
      if (deps.dryRun) {
        deps.log(`would ping: ${describe(plan)}`);
        sum.would++;
      } else {
        deps.notify(pingText(plan), { kind: "plan", ref: pid, canWait: true });
        updatePlan(db, plan.id, { last_pinged_at: now.toISOString() }, now);
        sum.pinged++;
      }
    }
  }
}

export function pingText(p: Plan): string {
  const bits = [p.location ? `at ${oneLine(p.location, 60)}` : null, p.cost ? `cost: ${oneLine(p.cost, 40)}` : null, p.bring ? `bring: ${oneLine(p.bring, 60)}` : null].filter(Boolean);
  return [
    `${p.plan_status === "confirmed" ? "Plan" : "Possible plan (not confirmed yet)"} in ${oneLine(p.source_chat_name, 40)}: ${describe(p)}${bits.length ? ` ${bits.join(", ")}` : ""}.`,
    p.my_stance === "unsure" ? "You said maybe." : "You haven't replied.",
    `(${planCode(p.id)})`,
  ].join(" ");
}

export async function runActions(deps: ActionDeps): Promise<ActionSummary> {
  const sum: ActionSummary = { created: 0, updated: 0, removed: 0, pinged: 0, clashes: 0, would: 0, errors: [] };
  for (const plan of allPlans(deps.db)) {
    try {
      await handlePlan(deps, getPlan(deps.db, plan.id)!, sum);
    } catch (err) {
      sum.errors.push(`${planCode(plan.id)}: ${(err as Error).message}`);
    }
  }
  if (sum.errors.length && !deps.dryRun) {
    deps.notify(`⚠️ Plans: could not finish some calendar actions. ${oneLine(sum.errors[0], 150)}`, { dedupeKey: "plans-calendar-error", cooldownMs: COOLDOWN_CALENDAR_MS, canWait: true });
  }
  return sum;
}

// ---------------------------------------------------------------- my replies to those messages
/** Record an explicit choice I made on Telegram, as if I had said it in the chat just now. */
export function ownerStance(db: Database.Database, planId: number, stance: "committed" | "declined", now: Date): void {
  addStance(db, planId, { stance, message_id: `owner:${now.toISOString()}`, chat_id: "telegram", ts: now.toISOString() }, now);
}
