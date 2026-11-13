import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pipeline as streamPipeline } from "node:stream/promises";
import type Database from "better-sqlite3";
import type { MediaReader } from "../plans/beeper";
import { allPlans, planCode, type Plan } from "../plans/store";
import { oneLine } from "../telegram/format";
import { dayKey } from "../telegram/time";
import type { NotifyOptions } from "../telegram/outbox";
import type { GraphClient } from "./graph";
import { checkFile } from "./media";
import {
  COOLDOWN_ALERT_MS, DAILY_BYTES_CAP, LOW_ONEDRIVE_BYTES, MAX_BACKLOG_DAYS, MAX_FILE_BYTES, MAX_UPLOADS_PER_RUN, MEDIA_SEEN_KEEP_DAYS,
  MIN_FREE_DISK_BYTES, ROOT_FOLDER_NAME, SCAN_OVERLAP_MINUTES, SCAN_PAGES, SWEEP_PAGES,
} from "./settings";
import {
  addBytesToday, bytesToday, countsForPlan, getPhotoPlan, getState, logOnce, markAttemptFailed, markFinal, markSaved, pendingToUpload, photoPlanFor,
  postpone, pruneOldMedia, queueItems, rememberMedia, seenMedia, setState, type SavedRow,
} from "./store";
import { findRuns, isEligible, photoWindow, planForMedia, type MediaItem, type WindowedPlan, type WindowStart } from "./window";

// The photos job, step by step. Everything that came from a chat (names, files) is untrusted data:
// it only ever becomes a folder/file name after sanitising, or bytes that are copied and uploaded.

export interface PhotoDeps {
  db: Database.Database;
  reader: MediaReader;
  /** null in dry run, or when OneDrive is not connected / the folder is not confirmed. */
  graph: GraphClient | null;
  /** Why graph is null (shown on the status page and in the log) when it is not dry run. */
  graphProblem?: string | null;
  notify: (text: string, options?: NotifyOptions) => unknown;
  dryRun: boolean;
  windowStart: WindowStart;
  minRun: number;
  gapMs: number;
  tmpDir: string;
  now: Date;
  log: (msg: string) => void;
  /** Free bytes on the disk that holds tmpDir. Injectable for tests. */
  freeDisk?: (dir: string) => number;
}

export interface PhotoResult {
  plans: number;
  scanned: number;
  newMedia: number;
  queued: number;
  wouldSave: number;
  saved: number;
  failed: number;
  errors: string[];
}

const defaultFreeDisk = (dir: string) => {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function runPhotos(deps: PhotoDeps): Promise<PhotoResult> {
  const { db, now, log } = deps;
  const result: PhotoResult = { plans: 0, scanned: 0, newMedia: 0, queued: 0, wouldSave: 0, saved: 0, failed: 0, errors: [] };

  // 1. Which plans, and when are their photo windows?
  const windowed: { plan: Plan; w: WindowedPlan }[] = [];
  for (const plan of allPlans(db)) {
    if (!isEligible(plan)) continue;
    const window = photoWindow(plan, deps.windowStart);
    if (!window) continue;
    if (now.getTime() > window.sweepAt.getTime() + MAX_BACKLOG_DAYS * 86_400_000) continue; // long finished
    windowed.push({ plan, w: { id: plan.id, window, chatIds: [plan.source_chat_id, ...plan.linked_chats.map((c) => c.id)] } });
  }
  result.plans = windowed.length;
  const all = windowed.map((x) => x.w);

  // 2. Read the chats of plans whose window has started and whose final sweep is not done.
  for (const { plan, w } of windowed) {
    if (now < w.window.from) continue;
    if (getState(db, `sweep_done:${plan.id}`)) continue;
    const lastScan = getState(db, `scan:${plan.id}`);
    const sweeping = now >= w.window.sweepAt;
    // A normal scan starts a little before the last one; the sweep re-reads the whole window.
    const sinceMs = sweeping || !lastScan ? w.window.from.getTime() : Math.max(w.window.from.getTime(), Date.parse(lastScan) - SCAN_OVERLAP_MINUTES * 60_000);
    let ok = true;
    for (const chatId of w.chatIds) {
      try {
        const found = await deps.reader.recentMedia(chatId, new Date(sinceMs - 1).toISOString(), sweeping ? SWEEP_PAGES : SCAN_PAGES);
        result.newMedia += rememberMedia(db, found, now);
        result.scanned++;
      } catch (err) {
        ok = false;
        result.errors.push(`${planCode(plan.id)}: could not read a chat: ${oneLine((err as Error).message, 120)}`);
      }
    }
    // Only a clean read counts: if a chat could not be read, the next run reads the same stretch again.
    if (ok) {
      setState(db, `scan:${plan.id}`, now.toISOString(), now);
      if (sweeping) setState(db, `sweep_done:${plan.id}`, now.toISOString(), now);
    }
  }

  // 3. Give every stored photo to a plan, find the runs, and queue (or, in dry run, just report) them.
  const planById = new Map(windowed.map((x) => [x.plan.id, x.plan]));
  const chats = [...new Set(all.flatMap((p) => p.chatIds))];
  const from = all.length ? new Date(Math.min(...all.map((p) => p.window.from.getTime()))).toISOString() : now.toISOString();
  const to = all.length ? new Date(Math.max(...all.map((p) => p.window.to.getTime()))).toISOString() : now.toISOString();
  const perPlan = new Map<number, MediaItem[]>();
  for (const item of seenMedia(db, chats, from, to)) {
    const { plan, ambiguous } = planForMedia(item, all);
    if (!plan) continue;
    if (ambiguous && logOnce(db, plan.id, "overlap", `${item.messageId}:${item.attachmentId}`, `Two plans in this chat overlap; this photo went to ${planCode(plan.id)} (the one that ended most recently)`, deps.dryRun, now)) {
      log(`photo in ${item.chatId} fits two plans: gave it to ${planCode(plan.id)}`);
    }
    perPlan.set(plan.id, [...(perPlan.get(plan.id) ?? []), item]);
  }

  for (const [planId, items] of perPlan) {
    const plan = planById.get(planId)!;
    const run = findRuns(items, deps.minRun, deps.gapMs).flat();
    if (!run.length) continue;
    const row = photoPlanFor(db, plan, now); // fixes the folder names the first time
    const where = `${ROOT_FOLDER_NAME} / ${row.chat_folder} / ${row.event_folder}`;

    if (deps.dryRun) {
      if (logOnce(db, planId, "would_save", String(run.length), `would save ${plural(run.length, "item")} to ${where}`, true, now)) log(`${planCode(planId)}: would save ${plural(run.length, "item")} to ${where}`);
      result.wouldSave += run.length;
      continue;
    }
    result.queued += queueItems(db, planId, run, now);
  }

  // 4. Upload what is queued, then summarise plans whose window is over.
  if (!deps.dryRun) {
    if (!deps.graph) {
      const waiting = (db.prepare(`SELECT COUNT(*) AS n FROM media_saved WHERE status = 'pending'`).get() as { n: number }).n;
      if (waiting) log(`${plural(waiting, "file")} waiting: ${deps.graphProblem ?? "OneDrive is not ready"}`);
    } else {
      await uploadQueue(deps, result);
    }
    summarise(deps, windowed.map((x) => x.plan));
  }

  pruneOldMedia(db, MEDIA_SEEN_KEEP_DAYS, now);
  return result;
}

// ---- Folders

/** Walk Uni Events / chat / event, making the folders only if missing. Never renames anything. */
async function resolveFolder(deps: PhotoDeps, planId: number): Promise<string> {
  const row = getPhotoPlan(deps.db, planId)!;
  const rootId = getState(deps.db, "uni_events_id")!;
  const chat = await deps.graph!.ensureFolder(rootId, row.chat_folder);
  deps.db.prepare(`UPDATE photo_chat_folders SET folder_item_id = ? WHERE chat_id = ?`).run(chat.id, row.chat_id);
  const event = await deps.graph!.ensureFolder(chat.id, row.event_folder);
  deps.db.prepare(`UPDATE photo_plans SET folder_item_id = ? WHERE plan_id = ?`).run(event.id, planId);
  if (!row.announced_at) {
    // Marked before it is queued, so it can never be sent twice.
    deps.db.prepare(`UPDATE photo_plans SET announced_at = ? WHERE plan_id = ? AND announced_at IS NULL`).run(deps.now.toISOString(), planId);
    deps.notify(`📷 Saving photos from ${oneLine(row.chat_folder, 60)} to ${ROOT_FOLDER_NAME} / ${oneLine(row.chat_folder, 60)} / ${oneLine(row.event_folder, 80)}`, { kind: "photos", ref: planCode(planId), canWait: true });
    logOnce(deps.db, planId, "folder", "created", `Folder ready: ${ROOT_FOLDER_NAME} / ${row.chat_folder} / ${row.event_folder}`, false, deps.now);
  }
  return event.id;
}

// ---- Uploading

function alertOnce(deps: PhotoDeps, key: string, text: string): void {
  deps.notify(`⚠️ Event photos: ${text}`, { dedupeKey: key, cooldownMs: COOLDOWN_ALERT_MS, canWait: true });
}

async function uploadQueue(deps: PhotoDeps, result: PhotoResult): Promise<void> {
  const { db, now } = deps;
  const rows = pendingToUpload(db, now, MAX_UPLOADS_PER_RUN);
  if (!rows.length) return;
  const freeDisk = deps.freeDisk ?? defaultFreeDisk;
  fs.mkdirSync(deps.tmpDir, { recursive: true, mode: 0o700 });

  // OneDrive space, once per run.
  try {
    const q = await deps.graph!.quota();
    setState(db, "quota_remaining", String(q.remaining), now);
    setState(db, "quota_total", String(q.total), now);
    if (q.remaining < LOW_ONEDRIVE_BYTES) alertOnce(deps, "photos-onedrive-low", `OneDrive has only ${(q.remaining / 1024 ** 3).toFixed(1)} GB free.`);
  } catch (err) {
    result.errors.push(`could not check OneDrive space: ${oneLine((err as Error).message, 100)}`);
  }
  const remainingBytes = Number(getState(db, "quota_remaining") ?? Infinity);

  const folderIds = new Map<number, string>();
  for (const row of rows) {
    if (bytesToday(db, now) >= DAILY_BYTES_CAP) {
      alertOnce(deps, `photos-daily-cap-${dayKey(now)}`, `5 GB uploaded today, so I stopped for the day. The rest continues tomorrow.`);
      break;
    }
    if (freeDisk(deps.tmpDir) < MIN_FREE_DISK_BYTES) {
      alertOnce(deps, "photos-disk-low", `less than ${(MIN_FREE_DISK_BYTES / 1024 ** 3).toFixed(0)} GB of disk space is free on the Mac mini, so I stopped saving.`);
      break;
    }
    try {
      if (!folderIds.has(row.plan_id)) folderIds.set(row.plan_id, await resolveFolder(deps, row.plan_id));
      const outcome = await saveOne(deps, row, folderIds.get(row.plan_id)!, freeDisk, remainingBytes);
      if (outcome === "saved") result.saved++;
      else if (outcome === "failed") result.failed++;
    } catch (err) {
      // Folder trouble or a sign-in problem: not this file's fault, so it is not counted against it.
      const msg = oneLine((err as Error).message, 150);
      result.errors.push(msg);
      postpone(db, row, new Date(now.getTime() + 10 * 60_000));
      alertOnce(deps, "photos-onedrive-error", `${msg}`);
      break;
    }
  }
}

/** Download one file, check it, upload it, delete the temp copy. */
async function saveOne(deps: PhotoDeps, row: SavedRow, folderId: string, freeDisk: (d: string) => number, onedriveRemaining: number): Promise<"saved" | "failed" | "final"> {
  const { db, now } = deps;
  const seen = db.prepare(`SELECT attachment_id, mime, file_size FROM media_seen WHERE message_id = ? AND attachment_id = ?`).get(row.message_id, row.attachment_id) as
    | { attachment_id: string; mime: string | null; file_size: number | null }
    | undefined;
  if (!seen) {
    markFinal(db, row, "rejected", "no longer in the seen list");
    return "final";
  }
  const tooBig = (bytes: number) => {
    markFinal(db, row, "skipped", `over ${MAX_FILE_BYTES / 1024 ** 3} GB (${(bytes / 1024 ** 3).toFixed(1)} GB)`);
    alertOnce(deps, `photos-big-${row.attachment_id.slice(-40)}`, `skipped a file over 1 GB (${(bytes / 1024 ** 3).toFixed(1)} GB) in ${oneLine(getPhotoPlan(db, row.plan_id)?.chat_folder, 50)}.`);
  };
  if (seen.file_size && seen.file_size > MAX_FILE_BYTES) {
    tooBig(seen.file_size);
    return "final";
  }
  if (seen.file_size && freeDisk(deps.tmpDir) < MIN_FREE_DISK_BYTES + seen.file_size * 2) {
    alertOnce(deps, "photos-disk-low", `not enough disk space for a ${(seen.file_size / 1024 ** 2).toFixed(0)} MB file. Waiting.`);
    postpone(db, row, new Date(now.getTime() + 30 * 60_000));
    return "failed";
  }

  const tmpFile = path.join(deps.tmpDir, `${randomBytes(8).toString("hex")}.part`);
  try {
    const cached = await deps.reader.downloadMedia(row.attachment_id);
    const size = fs.statSync(cached).size;
    if (size > MAX_FILE_BYTES) {
      tooBig(size);
      return "final";
    }
    if (size > onedriveRemaining) throw new Error(`OneDrive does not have room for this ${(size / 1024 ** 2).toFixed(0)} MB file`);
    if (bytesToday(db, now) + size > DAILY_BYTES_CAP) {
      postpone(db, row, new Date(now.getTime() + 6 * 3_600_000));
      return "failed";
    }
    // Copy (streamed) into our own temp folder; the original stays in Beeper's cache, which is not ours to touch.
    await streamPipeline(fs.createReadStream(cached), fs.createWriteStream(tmpFile, { mode: 0o600 }));
    const check = checkFile(tmpFile, seen.mime);
    if (!check.ok) {
      markFinal(db, row, "rejected", check.reason);
      logOnce(db, row.plan_id, "rejected", `${row.message_id}:${row.attachment_id}`, `Rejected a file: ${check.reason}`, false, now);
      return "final";
    }
    const fileName = `${row.file_base}.${check.sniffed.ext}`;
    const itemId = await deps.graph!.uploadFile(folderId, fileName, tmpFile);
    markSaved(db, row, fileName, itemId, size, now);
    addBytesToday(db, now, size);
    return "saved";
  } catch (err) {
    const reason = oneLine((err as Error).message, 150);
    const gaveUp = markAttemptFailed(db, row, reason, now);
    deps.log(`${planCode(row.plan_id)}: upload failed (${row.attempts + 1}): ${reason}`);
    if (gaveUp) alertOnce(deps, `photos-failed-${row.plan_id}`, `gave up on a file in ${oneLine(getPhotoPlan(db, row.plan_id)?.chat_folder, 50)} after repeated failures: ${reason}`);
    return "failed";
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

// ---- The summary, once per plan, when its window is over and nothing is waiting

function summarise(deps: PhotoDeps, plans: Plan[]): void {
  const { db, now } = deps;
  for (const plan of plans) {
    const row = getPhotoPlan(db, plan.id);
    if (!row || !row.announced_at || !getState(db, `sweep_done:${plan.id}`) || row.summary_sent_at) continue;
    const c = countsForPlan(db, plan.id);
    if (c.pending > 0) continue; // still uploading: say it once, at the end
    db.prepare(`UPDATE photo_plans SET summary_sent_at = ? WHERE plan_id = ? AND summary_sent_at IS NULL`).run(now.toISOString(), plan.id);
    const parts = [c.photos ? plural(c.photos, "photo") : "", c.videos ? plural(c.videos, "video") : ""].filter(Boolean).join(" and ") || "nothing";
    const trouble = [c.failed ? `${c.failed} failed` : "", c.skipped ? `${c.skipped} skipped (too big)` : "", c.rejected ? `${c.rejected} not photos or videos` : ""].filter(Boolean).join(", ");
    deps.notify(`📷 Saved ${parts} to ${ROOT_FOLDER_NAME} / ${oneLine(row.chat_folder, 60)} / ${oneLine(row.event_folder, 80)}${trouble ? ` (${trouble})` : ""}`, { kind: "photos", ref: planCode(plan.id), canWait: true });
    logOnce(db, plan.id, "summary", "sent", `Summary sent: ${parts}`, false, now);
  }
}
