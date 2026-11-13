import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { config } from "../config";
import { esc } from "../html";
import { ago } from "../telegram/format";
import { oneLine } from "../telegram/format";
import { planCode, type Plan } from "../plans/store";
import { dayKey } from "../telegram/time";
import { DAILY_BYTES_CAP, MIN_FREE_DISK_BYTES } from "./settings";
import { OneDriveAuth } from "./onedrive-auth";
import { bytesToday, countsForPlan, getState, type PhotoPlanRow } from "./store";

// The "Event photos" parts of the status page and the plans page. Pure reads of the database (plus the free
// disk space); everything that came from a chat goes through esc().

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const fmt = (iso: string) => new Date(iso).toLocaleString("en-AU", { hour12: false, timeZone: "Australia/Sydney" });

function freeDiskText(dir: string): string {
  try {
    const s = fs.statfsSync(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    return free < MIN_FREE_DISK_BYTES ? `<span class="failure">${gb(free)} free (low)</span>` : `${gb(free)} free`;
  } catch {
    return "unknown";
  }
}

/** The "Event photos" block (shown inside the Plans status block, on the status page and at the top of /plans). */
export function photosSection(db: Database.Database, now = new Date()): string {
  const auth = new OneDriveAuth(db, config.MS_CLIENT_ID ?? "", fetch, undefined, () => now).status();
  const root = getState(db, "uni_events_name");
  const mode = config.PHOTOS_DRY_RUN ? `<strong class="pending">DRY RUN</strong> (nothing is downloaded or uploaded)` : `<strong class="success">LIVE</strong>`;
  const connection = !auth.configured
    ? `<span class="pending">not set up</span> (MS_CLIENT_ID missing)`
    : auth.needsLogin
      ? `<span class="failure">sign-in expired</span> (run npm run photos:setup)`
      : !auth.connected
        ? `<span class="pending">not signed in</span> (run npm run photos:setup)`
        : `<span class="success">signed in</span>`;
  const token =
    auth.refreshedAt && auth.connected
      ? `, refreshed ${esc(ago(auth.refreshedAt, now))}, about ${auth.daysLeft} days of margin${auth.daysLeft !== null && auth.daysLeft < 14 ? ` <span class="failure">(renew soon)</span>` : ""}`
      : "";
  const quota = getState(db, "quota_remaining");
  const today = dayKey(now);
  const uploadsToday = (db.prepare(`SELECT COUNT(*) AS n FROM media_saved WHERE status = 'saved' AND saved_at >= ?`).get(new Date(now.getTime() - 86_400_000).toISOString()) as { n: number }).n;
  const waiting = db.prepare(`SELECT SUM(status = 'pending') AS pending, SUM(status = 'failed') AS failed FROM media_saved`).get() as { pending: number | null; failed: number | null };
  const problem = getState(db, "last_problem");
  const runError = getState(db, "last_run_error");
  const dataDir = path.dirname(config.DB_PATH);

  return `<h2>Event photos</h2>
<p>Mode: ${mode} · window starts at the plan's <strong>${esc(config.PHOTO_WINDOW_START)}</strong> · a run is ${config.PHOTOS_MIN_RUN}+ items, ${config.PHOTOS_RUN_GAP_MINUTES} min apart<br>
   OneDrive: ${connection}${token}<br>
   Folder: ${root ? esc(root) : `<span class="pending">not confirmed</span> (npm run photos:setup)`}${quota ? ` · OneDrive free: ${gb(Number(quota))}` : ""}<br>
   Uploads in the last day: ${uploadsToday} · uploaded today: ${gb(bytesToday(db, now))} of ${gb(DAILY_BYTES_CAP)} cap (${esc(today)}) · waiting: ${waiting.pending ?? 0} · failed: ${waiting.failed ?? 0}<br>
   Disk: ${freeDiskText(dataDir)} · last check: ${esc(ago(getState(db, "last_run_at"), now))}</p>
${problem && !config.PHOTOS_DRY_RUN ? `<p class="failure"><strong>Not uploading:</strong> ${esc(problem)}</p>` : ""}
${runError ? `<p class="failure"><strong>Last photos error:</strong> ${esc(runError)}</p>` : ""}`;
}

/** The "Event photos" section of /plans: per plan, plus the dry-run log and any failed uploads. */
export function photosPageHtml(db: Database.Database, plans: Plan[]): string {
  const byId = new Map(plans.map((p) => [p.id, p]));
  const rows = db.prepare(`SELECT * FROM photo_plans ORDER BY plan_id DESC`).all() as PhotoPlanRow[];
  const planRows = rows
    .map((r) => {
      const p = byId.get(r.plan_id);
      const c = countsForPlan(db, r.plan_id);
      const saved = c.photos || c.videos ? `${c.photos} photos, ${c.videos} videos` : `<span class="muted">none yet</span>`;
      const extra = [c.pending ? `${c.pending} waiting` : "", c.failed ? `<span class="failure">${c.failed} failed</span>` : "", c.skipped ? `${c.skipped} skipped` : "", c.rejected ? `${c.rejected} rejected` : ""].filter(Boolean).join(" · ");
      return `<tr><td><strong>${esc(planCode(r.plan_id))}</strong> ${esc(p?.title ?? "")}</td><td>${esc(r.chat_folder)} / ${esc(r.event_folder)}</td><td>${saved}${extra ? `<br>${extra}` : ""}</td><td class="muted">${c.lastSavedAt ? esc(fmt(c.lastSavedAt)) : "never"}</td></tr>`;
    })
    .join("");
  const log = (db.prepare(`SELECT plan_id, kind, dry_run, detail, created_at FROM photo_log ORDER BY id DESC LIMIT 40`).all() as { plan_id: number; kind: string; dry_run: number; detail: string | null; created_at: string }[])
    .map((l) => `<tr><td>${esc(fmt(l.created_at))}</td><td>${esc(planCode(l.plan_id))}</td><td>${esc(l.dry_run ? "would" : l.kind)}</td><td>${esc(l.detail ?? "")}</td></tr>`)
    .join("");
  const failed = (db.prepare(`SELECT plan_id, kind, ts, attempts, error, status FROM media_saved WHERE status IN ('failed','pending') AND error IS NOT NULL ORDER BY ts DESC LIMIT 30`).all() as { plan_id: number; kind: string; ts: string; attempts: number; error: string | null; status: string }[])
    .map((f) => `<tr><td>${esc(planCode(f.plan_id))}</td><td>${esc(f.kind.toLowerCase())} from ${esc(fmt(f.ts))}</td><td>${esc(f.status)} (${f.attempts} tries)</td><td>${esc(oneLine(f.error, 150))}</td></tr>`)
    .join("");

  return `<h2>Event photos: saved</h2>
<table><tr><th>Plan</th><th>Folder</th><th>Saved</th><th>Last upload</th></tr>${planRows || `<tr><td colspan="4" class="muted">No plan has a run of photos yet.</td></tr>`}</table>
<h3>What Jarvis ${config.PHOTOS_DRY_RUN ? "WOULD do" : "did"}</h3>
<table><tr><th>When</th><th>Plan</th><th>Action</th><th>Detail</th></tr>${log || `<tr><td colspan="4" class="muted">Nothing yet.</td></tr>`}</table>
${failed ? `<h3>Failed or retrying uploads</h3><table><tr><th>Plan</th><th>File</th><th>State</th><th>Why</th></tr>${failed}</table>` : ""}`;
}
