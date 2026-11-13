import type Database from "better-sqlite3";
import { scheduleToWords } from "../format";
import type { JobVM, RegisteredJob, RunVM } from "./types";

// Job rows for the Jobs page and the health banner. The stale-job rule lives here.

/** A job is overdue when its next run is more than this many intervals in the past (and never less than MIN_OVERDUE_MS). */
export const OVERDUE_INTERVALS = 2;
export const MIN_OVERDUE_MS = 10 * 60_000;
/** A job that has never run is only overdue once its first run is this late. */
export const FIRST_RUN_GRACE_MS = 60_000;
/** Jobs whose successful runs are noise in the global run list (they run every few minutes). */
export const NOISY_JOBS = ["heartbeat", "plans-poll"];

interface JobRow {
  name: string;
  schedule: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  consecutive_failures: number;
}
interface LatestRun {
  job: string;
  started_at: string;
  status: string;
  duration_ms: number | null;
}

const date = (iso: string | null | undefined) => (iso ? new Date(iso) : null);

/**
 * Overdue = the next run was due more than `max(2 intervals, 10 min)` ago (the scheduler has stopped), or the job
 * has never reported and its first run is already late. A job that has not run yet but is not due is just "waiting".
 */
export function overdueState(opts: { enabled: boolean; retired: boolean; lastRunAt: Date | null; nextRunAt: Date | null; intervalMs: number; now: Date }): { overdue: boolean; waiting: boolean; reason: string | null } {
  const { enabled, retired, lastRunAt, nextRunAt, intervalMs, now } = opts;
  if (!enabled || retired) return { overdue: false, waiting: false, reason: null };
  if (!nextRunAt) return { overdue: false, waiting: false, reason: null };
  const late = now.getTime() - nextRunAt.getTime();
  const allowed = Math.max(OVERDUE_INTERVALS * intervalMs, MIN_OVERDUE_MS);
  if (late > allowed) return { overdue: true, waiting: false, reason: "next run was due long ago: the schedule may have stopped" };
  if (!lastRunAt) {
    if (late > FIRST_RUN_GRACE_MS) return { overdue: true, waiting: false, reason: "has never reported a result and its first run is late" };
    return { overdue: false, waiting: true, reason: null };
  }
  return { overdue: false, waiting: false, reason: null };
}

export function buildJobs(db: Database.Database, registered: RegisteredJob[], now: Date): JobVM[] {
  const jobs = db.prepare(`SELECT name, schedule, enabled, last_run_at, next_run_at, consecutive_failures FROM jobs ORDER BY name`).all() as JobRow[];
  const latest = db.prepare(`SELECT job, started_at, status, duration_ms FROM runs WHERE id IN (SELECT MAX(id) FROM runs GROUP BY job)`).all() as LatestRun[];
  const latestBy = new Map(latest.map((r) => [r.job, r]));
  const reg = new Map(registered.map((r) => [r.name, r]));

  return jobs.map((j): JobVM => {
    const r = reg.get(j.name);
    const retired = !r;
    const lastRunAt = date(j.last_run_at);
    const nextRunAt = date(j.next_run_at);
    const run = latestBy.get(j.name);
    // "Quiet" jobs delete their successful, silent runs. So: a run row at (or after) the last run time is that run's
    // result; no such row but a last run time means it ran and had nothing to report.
    const rowIsLast = run && lastRunAt && Date.parse(run.started_at) >= lastRunAt.getTime() - 1000;
    let lastStatus: JobVM["lastStatus"] = null;
    let quiet = false;
    if (rowIsLast) lastStatus = run!.status === "running" ? "running" : run!.status === "success" ? "success" : "failure";
    else if (lastRunAt) {
      lastStatus = "success";
      quiet = true;
    } else if (run?.status === "running") lastStatus = "running";
    const o = overdueState({ enabled: j.enabled === 1, retired, lastRunAt, nextRunAt, intervalMs: r?.intervalMs ?? 0, now });
    return {
      name: j.name,
      scheduleHuman: scheduleToWords(j.schedule, r?.timezone),
      cron: j.schedule,
      enabled: j.enabled === 1,
      lastRunAt,
      lastStatus,
      quiet,
      lastDurationMs: rowIsLast ? run!.duration_ms : null,
      nextRunAt,
      overdue: o.overdue,
      overdueReason: o.reason,
      waiting: o.waiting,
      consecutiveFailures: j.consecutive_failures,
      retired,
    };
  });
}

/** The time of a job's last successful run, or null (a failing job has no recent success). */
export function lastOkAt(jobs: JobVM[], name: string): Date | null {
  const j = jobs.find((x) => x.name === name);
  return j && j.lastStatus === "success" && j.consecutiveFailures === 0 ? j.lastRunAt : null;
}

export interface RunFilter {
  job?: string;
  /** Show everything, including heartbeat and plans-poll successes. */
  all?: boolean;
  limit?: number;
}

/** Latest runs: failures first, then newest. Noisy successes are hidden unless `all`, or a specific job is asked for. */
export function buildRuns(db: Database.Database, filter: RunFilter = {}): { runs: RunVM[]; hiddenNoisy: number } {
  const limit = filter.limit ?? 30;
  const rows = (filter.job
    ? db.prepare(`SELECT id, job, started_at, status, duration_ms, log FROM runs WHERE job = ? ORDER BY id DESC LIMIT 200`).all(filter.job)
    : db.prepare(`SELECT id, job, started_at, status, duration_ms, log FROM runs ORDER BY id DESC LIMIT 400`).all()) as { id: number; job: string; started_at: string; status: string; duration_ms: number | null; log: string | null }[];
  const showAll = filter.all || Boolean(filter.job);
  const isNoise = (r: { job: string; status: string }) => NOISY_JOBS.includes(r.job) && r.status === "success";
  const kept = showAll ? rows : rows.filter((r) => !isNoise(r));
  const hiddenNoisy = showAll ? 0 : rows.length - kept.length;
  const rank = (s: string) => (s === "failure" ? 0 : s === "running" ? 1 : 2);
  const sorted = [...kept].sort((a, b) => rank(a.status) - rank(b.status) || b.id - a.id).slice(0, limit);
  return {
    hiddenNoisy,
    runs: sorted.map((r) => ({
      id: r.id,
      job: r.job,
      startedAt: new Date(r.started_at),
      status: r.status === "success" ? "success" : r.status === "running" ? "running" : "failure",
      durationMs: r.duration_ms,
      log: r.log,
    })),
  };
}
