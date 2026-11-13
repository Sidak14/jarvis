import { zoned, zonedTime } from "../telegram/time";
import type { Plan } from "../plans/store";
import { DEFAULT_DURATION_HOURS, SWEEP_AFTER_MINUTES, WINDOW_HOURS } from "./settings";

// Pure functions: which plans get photos, when, and which photos belong to which plan.
// No database, no network, so all of it is tested directly.

export type WindowStart = "end" | "start";

export interface PhotoWindow {
  start: Date; // the plan's start
  end: Date; // the plan's end (start + 2 hours when it has none)
  from: Date; // photos count from here...
  to: Date; // ...until here (inclusive)
  sweepAt: Date; // the final sweep time: `to` + 30 minutes
}

/** Only plans I went to: confirmed AND my stance is committed. */
export const isEligible = (p: Plan): boolean => p.plan_status === "confirmed" && p.my_stance === "committed" && !p.archived_at;

/** "YYYY-MM-DD" + "HH:MM" in Sydney -> the moment, or null if either is not usable. */
function at(date: string, time: string, addDays = 0): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!d || !t) return null;
  return zonedTime(+d[1], +d[2], +d[3] + addDays, +t[1] * 60 + +t[2]);
}

/**
 * The photo window of a plan, or null if it has no usable date and start time.
 * - end: the plan's end time; none -> start + 2 hours; an end earlier than the start means "after midnight".
 * - from: the plan's END by default (PHOTO_WINDOW_START=end), or its start (=start, also catches photos sent DURING the event).
 * - to: end + 24 hours of Sydney wall-clock time. Across a daylight-saving change that is 23 or 25 real hours, on purpose:
 *   "the next day at the same time" is what a person means.
 */
export function photoWindow(p: Plan, windowStart: WindowStart): PhotoWindow | null {
  if (!p.date || !p.start_time) return null;
  const start = at(p.date, p.start_time);
  if (!start) return null;
  let end = p.end_time ? at(p.date, p.end_time) : null;
  if (p.end_time && end && end <= start) end = p.end_time < p.start_time ? at(p.date, p.end_time, 1) : null; // past midnight
  if (!end || end <= start) end = new Date(start.getTime() + DEFAULT_DURATION_HOURS * 3_600_000);

  const z = zoned(end);
  const to = zonedTime(z.year, z.month, z.day + WINDOW_HOURS / 24, z.hour * 60 + z.minute);
  return { start, end, from: windowStart === "start" ? start : end, to, sweepAt: new Date(to.getTime() + SWEEP_AFTER_MINUTES * 60_000) };
}

export interface MediaItem {
  chatId: string;
  messageId: string;
  attachmentId: string;
  /** Position inside its message (an album can hold several). */
  index: number;
  senderId: string;
  ts: string; // ISO
  kind: "IMAGE" | "VIDEO";
  mime: string | null;
  size: number | null;
}

export interface WindowedPlan {
  id: number;
  window: PhotoWindow;
  /** The source chat and every linked chat. */
  chatIds: string[];
}

/**
 * Which plan does a photo belong to? One whose chat it was sent in and whose window contains it (both ends inclusive).
 * Several -> the one that ENDED most recently (before the photo if possible); `ambiguous` is true so the caller can log it.
 */
export function planForMedia(item: Pick<MediaItem, "chatId" | "ts">, plans: WindowedPlan[]): { plan: WindowedPlan | null; ambiguous: boolean } {
  const t = Date.parse(item.ts);
  const candidates = plans.filter((p) => p.chatIds.includes(item.chatId) && t >= p.window.from.getTime() && t <= p.window.to.getTime());
  if (candidates.length === 0) return { plan: null, ambiguous: false };
  if (candidates.length === 1) return { plan: candidates[0], ambiguous: false };
  const ended = candidates.filter((p) => p.window.end.getTime() <= t);
  const pool = ended.length ? ended : candidates;
  const key = (p: WindowedPlan) => (ended.length ? p.window.end.getTime() : p.window.start.getTime());
  const best = [...pool].sort((a, b) => key(b) - key(a) || b.id - a.id)[0];
  return { plan: best, ambiguous: true };
}

/**
 * The runs worth saving. A run is one sender's photos/videos where each is within `gapMs` of that sender's previous one
 * (text messages, and other people's photos, in between do not break it). It needs `minItems` or more; every item of it
 * is returned, so a run that keeps growing keeps being saved. Items are sorted by time, then message id, then position.
 */
export function findRuns(items: MediaItem[], minItems: number, gapMs: number): MediaItem[][] {
  const bySender = new Map<string, MediaItem[]>();
  for (const it of items) bySender.set(it.senderId, [...(bySender.get(it.senderId) ?? []), it]);
  const runs: MediaItem[][] = [];
  for (const list of bySender.values()) {
    list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.messageId.localeCompare(b.messageId) || a.index - b.index);
    let run: MediaItem[] = [];
    for (const it of list) {
      const prev = run[run.length - 1];
      if (prev && Date.parse(it.ts) - Date.parse(prev.ts) > gapMs) {
        if (run.length >= minItems) runs.push(run);
        run = [];
      }
      run.push(it);
    }
    if (run.length >= minItems) runs.push(run);
  }
  return runs;
}
