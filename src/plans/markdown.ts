import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { dayKey, startOfDay, zoned } from "../telegram/time";
import { ARCHIVE_AFTER_DAYS, ARCHIVE_FILE, PLANS_FILE } from "./settings";
import { allPlans, planCode, parsePlanCode, stanceTimeline, updatePlan, type Plan, type StanceEntry } from "./store";

// plans.md: a readable copy of the plans, written by CODE only (never by the model) from the
// plans table. Every line is `key: <JSON value>`, so it can be read back strictly. Only extracted
// fields and message ids are stored here, never chat text.
//   - writes are atomic (temp file, then rename), with a backup first, and one writer at a time
//   - plans more than 14 days past move to plans-archive.md

export type PlanRecord = Omit<Plan, "id"> & { id: number; stance_timeline: StanceEntry[] };

// Order matters: this is the order the keys are written, and the exact set the parser accepts.
const KEYS = [
  "title", "plan_status", "my_stance", "stance_timeline", "date_certainty", "confidence",
  "chat", "chat_id", "linked_chats", "what", "date", "start_time", "end_time", "location", "meeting_point",
  "participants", "cost", "bring", "url", "notes", "possible_link", "source_message_ids", "history",
  "raised_at", "created_at", "last_updated", "replied_at",
  "calendar_event_id", "event_link", "event_version", "cal_state", "cal_state_version", "last_pinged_at", "archived_at",
] as const;

const HEADER = `# Jarvis plans\n<!-- Written by Jarvis from its database. Do not edit: changes are overwritten. -->\n`;

function recordValue(r: PlanRecord, key: (typeof KEYS)[number]): unknown {
  switch (key) {
    case "chat": return r.source_chat_name;
    case "chat_id": return r.source_chat_id;
    case "calendar_event_id": return r.event_id;
    default: return (r as unknown as Record<string, unknown>)[key];
  }
}

export function renderPlan(r: PlanRecord): string {
  const lines = [`## ${planCode(r.id)} ${r.title.replace(/[\r\n]+/g, " ")}`];
  for (const k of KEYS) lines.push(`${k}: ${JSON.stringify(recordValue(r, k) ?? null)}`);
  return lines.join("\n");
}
export function renderPlans(records: PlanRecord[]): string {
  return `${HEADER}\n${records.map(renderPlan).join("\n\n")}${records.length ? "\n" : ""}`;
}

/** Strict reader: any surprise (unknown key, missing key, bad JSON, bad header) throws. */
export function parsePlans(text: string): PlanRecord[] {
  if (!text.startsWith(HEADER)) throw new Error("plans.md: unexpected header");
  const body = text.slice(HEADER.length).trim();
  if (!body) return [];
  const records: PlanRecord[] = [];
  for (const section of body.split(/\n\n(?=## P-)/)) {
    const lines = section.split("\n");
    const head = /^## (P-\d{1,6}) (.*)$/.exec(lines[0]);
    if (!head) throw new Error(`plans.md: bad section heading "${lines[0].slice(0, 40)}"`);
    const id = parsePlanCode(head[1])!;
    const values = new Map<string, unknown>();
    for (const line of lines.slice(1)) {
      const m = /^([a-z_]+): (.*)$/.exec(line);
      if (!m || !(KEYS as readonly string[]).includes(m[1]) || values.has(m[1])) throw new Error(`plans.md: bad line in ${head[1]}: "${line.slice(0, 40)}"`);
      try {
        values.set(m[1], JSON.parse(m[2]));
      } catch {
        throw new Error(`plans.md: bad value for ${m[1]} in ${head[1]}`);
      }
    }
    for (const k of KEYS) if (!values.has(k)) throw new Error(`plans.md: ${head[1]} is missing ${k}`);
    const v = (k: (typeof KEYS)[number]) => values.get(k) as never;
    records.push({
      id, title: v("title"), plan_status: v("plan_status"), my_stance: v("my_stance"), stance_timeline: v("stance_timeline"),
      date_certainty: v("date_certainty"), confidence: v("confidence"), source_chat_name: v("chat"), source_chat_id: v("chat_id"),
      linked_chats: v("linked_chats"), what: v("what"), date: v("date"), start_time: v("start_time"), end_time: v("end_time"),
      location: v("location"), meeting_point: v("meeting_point"), participants: v("participants"), cost: v("cost"), bring: v("bring"),
      url: v("url"), notes: v("notes"), possible_link: v("possible_link"), source_message_ids: v("source_message_ids"), history: v("history"),
      raised_at: v("raised_at"), created_at: v("created_at"), last_updated: v("last_updated"), replied_at: v("replied_at"),
      event_id: v("calendar_event_id"), event_link: v("event_link"), event_version: v("event_version"), cal_state: v("cal_state"),
      cal_state_version: v("cal_state_version"), last_pinged_at: v("last_pinged_at"), archived_at: v("archived_at"),
    });
  }
  return records;
}

// ---------------------------------------------------------------- files
let writing = false;

/** Write a file atomically: a temp file in the same folder, then rename over the target. */
export function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** A lock file next to the data, so two writers can never interleave. A stale lock (60s) is taken over. */
function withLock<T>(lockFile: string, fn: () => T): T | null {
  if (writing) return null;
  try {
    if (fs.existsSync(lockFile) && Date.now() - fs.statSync(lockFile).mtimeMs > 60_000) fs.unlinkSync(lockFile);
    fs.closeSync(fs.openSync(lockFile, "wx"));
  } catch {
    return null;
  }
  writing = true;
  try {
    return fn();
  } finally {
    writing = false;
    fs.rmSync(lockFile, { force: true });
  }
}

function recordsFor(db: Database.Database, plans: Plan[]): PlanRecord[] {
  return plans.map((p) => ({ ...p, stance_timeline: stanceTimeline(db, p.id) }));
}

/** Plans whose day was more than 14 days ago (or, with no day, last touched that long ago) are archived. */
function isStale(p: Plan, now: Date): boolean {
  const z = zoned(now);
  const cutoff = dayKey(new Date(startOfDay(z.year, z.month, z.day - ARCHIVE_AFTER_DAYS).getTime() + 12 * 3_600_000));
  return (p.date ?? p.last_updated.slice(0, 10)) < cutoff;
}

export function writePlanFiles(db: Database.Database, dataDir: string, now = new Date()): { wrote: boolean; archived: number } {
  fs.mkdirSync(dataDir, { recursive: true });
  const result = withLock(path.join(dataDir, `${PLANS_FILE}.lock`), () => {
    const plansFile = path.join(dataDir, PLANS_FILE);
    const archiveFile = path.join(dataDir, ARCHIVE_FILE);

    const stale = allPlans(db).filter((p) => isStale(p, now));
    if (stale.length) {
      const existing = fs.existsSync(archiveFile) ? fs.readFileSync(archiveFile, "utf8") : "";
      const previous = existing ? parsePlans(existing) : [];
      const merged = [...previous.filter((r) => !stale.some((s) => s.id === r.id)), ...recordsFor(db, stale)];
      if (fs.existsSync(archiveFile)) fs.copyFileSync(archiveFile, `${archiveFile}.bak`);
      atomicWrite(archiveFile, renderPlans(merged));
      for (const p of stale) updatePlan(db, p.id, { archived_at: now.toISOString() }, now);
    }

    const text = renderPlans(recordsFor(db, allPlans(db)));
    const current = fs.existsSync(plansFile) ? fs.readFileSync(plansFile, "utf8") : null;
    if (current === text) return { wrote: false, archived: stale.length };
    if (current !== null) fs.copyFileSync(plansFile, `${plansFile}.bak`); // a backup before each write
    atomicWrite(plansFile, text);
    return { wrote: true, archived: stale.length };
  });
  return result ?? { wrote: false, archived: 0 };
}

/**
 * Disaster recovery: if the plans table is empty but plans.md has plans, load them back.
 * Returns how many were restored.
 */
export function restoreFromFile(db: Database.Database, dataDir: string): number {
  const file = path.join(dataDir, PLANS_FILE);
  if (!fs.existsSync(file) || (db.prepare(`SELECT COUNT(*) FROM plans`).pluck().get() as number) > 0) return 0;
  const records = parsePlans(fs.readFileSync(file, "utf8"));
  db.transaction(() => {
    for (const r of records) {
      db.prepare(
        `INSERT INTO plans (id, title, what, date, start_time, end_time, location, meeting_point, participants, cost, bring, url, notes,
                            plan_status, my_stance, date_certainty, confidence, source_chat_id, source_chat_name, linked_chats, possible_link,
                            source_message_ids, history, raised_at, created_at, last_updated, replied_at, event_id, event_link, event_version,
                            cal_state, cal_state_version, last_pinged_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        r.id, r.title, r.what, r.date, r.start_time, r.end_time, r.location, r.meeting_point, JSON.stringify(r.participants), r.cost, r.bring, r.url,
        JSON.stringify(r.notes), r.plan_status, r.my_stance, r.date_certainty, r.confidence, r.source_chat_id, r.source_chat_name,
        JSON.stringify(r.linked_chats), r.possible_link ? JSON.stringify(r.possible_link) : null, JSON.stringify(r.source_message_ids),
        JSON.stringify(r.history), r.raised_at, r.created_at, r.last_updated, r.replied_at, r.event_id, r.event_link, r.event_version,
        r.cal_state, r.cal_state_version, r.last_pinged_at, r.archived_at,
      );
      for (const s of r.stance_timeline) {
        db.prepare(`INSERT OR IGNORE INTO plan_stances (plan_id, stance, message_id, chat_id, ts, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
          r.id, s.stance, s.message_id, s.chat_id, s.ts, r.created_at,
        );
      }
    }
  })();
  return records.length;
}
