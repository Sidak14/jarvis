import type Database from "better-sqlite3";
import { dayKey } from "../telegram/time";
import { chatFolderName, eventFolderName, fileStamp } from "./names";
import { MAX_ATTEMPTS, RETRY_MINUTES } from "./settings";
import type { MediaItem } from "./window";

// Small database helpers for the photos feature.

export function getState(db: Database.Database, key: string): string | null {
  return (db.prepare(`SELECT value FROM photo_state WHERE key = ?`).get(key) as { value: string | null } | undefined)?.value ?? null;
}
export function setState(db: Database.Database, key: string, value: string | null, now = new Date()): void {
  db.prepare(
    `INSERT INTO photo_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now.toISOString());
}

// ---- Bytes uploaded per Sydney day (the 5 GB cap)
export const bytesToday = (db: Database.Database, now: Date) => Number(getState(db, `bytes:${dayKey(now)}`) ?? 0);
export function addBytesToday(db: Database.Database, now: Date, bytes: number): void {
  setState(db, `bytes:${dayKey(now)}`, String(bytesToday(db, now) + bytes), now);
}

/** Log a line once. Returns true if it was new. */
export function logOnce(db: Database.Database, planId: number, kind: string, key: string, detail: string, dryRun: boolean, now: Date): boolean {
  return db.prepare(`INSERT OR IGNORE INTO photo_log (plan_id, kind, key, dry_run, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(planId, kind, key, dryRun ? 1 : 0, detail.slice(0, 300), now.toISOString()).changes > 0;
}

// ---- Media seen in chats
export function rememberMedia(db: Database.Database, items: MediaItem[], now: Date): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO media_seen (chat_id, message_id, attachment_id, idx, sender_id, ts, kind, mime, file_size, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let added = 0;
  db.transaction(() => {
    for (const i of items) added += insert.run(i.chatId, i.messageId, i.attachmentId, i.index, i.senderId, i.ts, i.kind, i.mime, i.size, now.toISOString()).changes;
  })();
  return added;
}

interface SeenRow {
  chat_id: string; message_id: string; attachment_id: string; idx: number; sender_id: string; ts: string; kind: "IMAGE" | "VIDEO"; mime: string | null; file_size: number | null;
}
export function seenMedia(db: Database.Database, chatIds: string[], fromIso: string, toIso: string): MediaItem[] {
  if (!chatIds.length) return [];
  const rows = db
    .prepare(`SELECT * FROM media_seen WHERE chat_id IN (${chatIds.map(() => "?").join(",")}) AND ts >= ? AND ts <= ? ORDER BY ts, message_id, idx`)
    .all(...chatIds, fromIso, toIso) as SeenRow[];
  return rows.map((r) => ({ chatId: r.chat_id, messageId: r.message_id, attachmentId: r.attachment_id, index: r.idx, senderId: r.sender_id, ts: r.ts, kind: r.kind, mime: r.mime, size: r.file_size }));
}

// ---- Folder names (fixed the first time they are needed)
export interface PhotoPlanRow {
  plan_id: number; chat_id: string; chat_folder: string; event_folder: string; folder_item_id: string | null;
  announced_at: string | null; summary_sent_at: string | null; created_at: string;
}
export const getPhotoPlan = (db: Database.Database, planId: number) =>
  db.prepare(`SELECT * FROM photo_plans WHERE plan_id = ?`).get(planId) as PhotoPlanRow | undefined;

/** The folder name of a chat: whatever it was called the first time, kept forever (a rename must not make a second folder). */
export function chatFolderFor(db: Database.Database, chatId: string, currentTitle: string, now: Date): string {
  const existing = db.prepare(`SELECT folder_name FROM photo_chat_folders WHERE chat_id = ?`).get(chatId) as { folder_name: string } | undefined;
  if (existing) return existing.folder_name;
  const name = chatFolderName(currentTitle);
  db.prepare(`INSERT INTO photo_chat_folders (chat_id, folder_name, first_seen_at) VALUES (?, ?, ?)`).run(chatId, name, now.toISOString());
  return name;
}

/** The plan's folder row, made the first time it is needed. The event folder name is never changed afterwards. */
export function photoPlanFor(db: Database.Database, plan: { id: number; title: string; date: string | null; source_chat_id: string; source_chat_name: string }, now: Date): PhotoPlanRow {
  const existing = getPhotoPlan(db, plan.id);
  if (existing) return existing;
  db.prepare(`INSERT INTO photo_plans (plan_id, chat_id, chat_folder, event_folder, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    plan.id, plan.source_chat_id, chatFolderFor(db, plan.source_chat_id, plan.source_chat_name, now), eventFolderName(plan.title, plan.date), now.toISOString(),
  );
  return getPhotoPlan(db, plan.id)!;
}

// ---- Saving
export interface SavedRow {
  message_id: string; attachment_id: string; plan_id: number; chat_id: string; kind: "IMAGE" | "VIDEO"; ts: string; file_base: string;
  file_name: string | null; onedrive_item_id: string | null; saved_at: string | null; status: "pending" | "saved" | "skipped" | "rejected" | "failed";
  attempts: number; next_attempt_at: string | null; error: string | null; bytes: number | null; created_at: string;
}

/**
 * Queue items for saving. Items already queued (or saved) are left alone. The file name is "<Sydney time>_<n>":
 * n counts the files of this plan that share the same second, so two photos can never get the same name.
 */
export function queueItems(db: Database.Database, planId: number, items: MediaItem[], now: Date): number {
  const exists = db.prepare(`SELECT 1 FROM media_saved WHERE message_id = ? AND attachment_id = ?`);
  const sameStamp = db.prepare(`SELECT COUNT(*) AS n FROM media_saved WHERE plan_id = ? AND file_base LIKE ? ESCAPE '\\'`);
  const insert = db.prepare(
    `INSERT INTO media_saved (message_id, attachment_id, plan_id, chat_id, kind, ts, file_base, status, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  );
  let queued = 0;
  db.transaction(() => {
    for (const i of items) {
      if (exists.get(i.messageId, i.attachmentId)) continue;
      const stamp = fileStamp(new Date(i.ts));
      const n = (sameStamp.get(planId, `${stamp.replace(/_/g, "\\_")}\\_%`) as { n: number }).n + 1;
      insert.run(i.messageId, i.attachmentId, planId, i.chatId, i.kind, i.ts, `${stamp}_${n}`, now.toISOString(), now.toISOString());
      queued++;
    }
  })();
  return queued;
}

export const pendingToUpload = (db: Database.Database, now: Date, limit: number) =>
  db.prepare(`SELECT * FROM media_saved WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY ts, message_id LIMIT ?`).all(now.toISOString(), limit) as SavedRow[];

export function markSaved(db: Database.Database, r: SavedRow, fileName: string, itemId: string, bytes: number, now: Date): void {
  db.prepare(`UPDATE media_saved SET status = 'saved', file_name = ?, onedrive_item_id = ?, bytes = ?, saved_at = ?, error = NULL WHERE message_id = ? AND attachment_id = ?`).run(fileName, itemId, bytes, now.toISOString(), r.message_id, r.attachment_id);
}
/** A permanent no: too big, not a photo or video. It is not retried. */
export function markFinal(db: Database.Database, r: SavedRow, status: "skipped" | "rejected", reason: string): void {
  db.prepare(`UPDATE media_saved SET status = ?, error = ? WHERE message_id = ? AND attachment_id = ?`).run(status, reason.slice(0, 200), r.message_id, r.attachment_id);
}
/** A failed attempt: try again later with a growing wait, and give up (status failed) after MAX_ATTEMPTS. Returns true when it gave up. */
export function markAttemptFailed(db: Database.Database, r: SavedRow, reason: string, now: Date): boolean {
  const attempts = r.attempts + 1;
  const giveUp = attempts >= MAX_ATTEMPTS;
  const wait = RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)];
  db.prepare(`UPDATE media_saved SET attempts = ?, error = ?, status = ?, next_attempt_at = ? WHERE message_id = ? AND attachment_id = ?`).run(
    attempts, reason.slice(0, 200), giveUp ? "failed" : "pending", new Date(now.getTime() + wait * 60_000).toISOString(), r.message_id, r.attachment_id,
  );
  return giveUp;
}
/** Put a not-yet-attempted row back (e.g. the daily cap was hit) without counting it as a failure. */
export const postpone = (db: Database.Database, r: SavedRow, until: Date) =>
  db.prepare(`UPDATE media_saved SET next_attempt_at = ? WHERE message_id = ? AND attachment_id = ?`).run(until.toISOString(), r.message_id, r.attachment_id);

export interface PlanCounts { photos: number; videos: number; pending: number; failed: number; skipped: number; rejected: number; lastSavedAt: string | null }
export function countsForPlan(db: Database.Database, planId: number): PlanCounts {
  const r = db
    .prepare(
      `SELECT SUM(status = 'saved' AND kind = 'IMAGE') AS photos, SUM(status = 'saved' AND kind = 'VIDEO') AS videos, SUM(status = 'pending') AS pending,
              SUM(status = 'failed') AS failed, SUM(status = 'skipped') AS skipped, SUM(status = 'rejected') AS rejected, MAX(saved_at) AS last
         FROM media_saved WHERE plan_id = ?`,
    )
    .get(planId) as Record<string, number | string | null>;
  const n = (v: unknown) => Number(v ?? 0);
  return { photos: n(r.photos), videos: n(r.videos), pending: n(r.pending), failed: n(r.failed), skipped: n(r.skipped), rejected: n(r.rejected), lastSavedAt: (r.last as string | null) ?? null };
}

export function pruneOldMedia(db: Database.Database, keepDays: number, now: Date): void {
  db.prepare(`DELETE FROM media_seen WHERE ts < ?`).run(new Date(now.getTime() - keepDays * 86_400_000).toISOString());
}
