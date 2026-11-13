import { Cron } from "croner";
import { db } from "./db";

export interface JobContext {
  /** Append a line to this run's captured log. */
  log: (message: string) => void;
}
export type JobHandler = (ctx: JobContext) => void | Promise<void>;

export interface JobOptions {
  /** IANA time zone for the cron expression (default: this Mac's). */
  timezone?: string;
  /** A successful run that logged nothing is not recorded in `runs` (for jobs that run every minute). */
  quiet?: boolean;
}

interface Registered {
  cron: Cron;
  handler: JobHandler;
  quiet: boolean;
  expression: string;
  timezone: string | null;
}

interface RunResult {
  status: "success" | "failure" | "skipped";
  runId: number | null;
}

const MAX_LOG_BYTES = 64 * 1024;
const registry = new Map<string, Registered>();
const running = new Set<string>(); // jobs executing right now

const upsertJob = db.prepare(
  `INSERT INTO jobs (name, schedule, enabled) VALUES (?, ?, 1)
   ON CONFLICT(name) DO UPDATE SET schedule = excluded.schedule`,
);
const getEnabled = db.prepare(`SELECT enabled FROM jobs WHERE name = ?`);
const insertRun = db.prepare(
  `INSERT INTO runs (job, started_at, status) VALUES (?, ?, 'running')`,
);
const finishRun = db.prepare(
  `UPDATE runs SET finished_at = ?, status = ?, duration_ms = ?, log = ? WHERE id = ?`,
);
// consecutive_failures is how many runs in a row failed (0 after any success). Alerts read it.
const touchJob = db.prepare(
  `UPDATE jobs SET last_run_at = ?, next_run_at = ?,
          consecutive_failures = CASE WHEN ? = 'success' THEN 0 ELSE consecutive_failures + 1 END
    WHERE name = ?`,
);
const deleteRun = db.prepare(`DELETE FROM runs WHERE id = ?`);
const setNext = db.prepare(`UPDATE jobs SET next_run_at = ? WHERE name = ?`);

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

async function execute(name: string): Promise<RunResult> {
  const entry = registry.get(name);
  if (!entry) return { status: "skipped", runId: null };

  const row = getEnabled.get(name) as { enabled: number } | undefined;
  if (row && row.enabled === 0) return { status: "skipped", runId: null };

  // Never run the same job twice at once (e.g. the schedule fires during a manual run).
  if (running.has(name)) return { status: "skipped", runId: null };
  running.add(name);

  try {
    const started = new Date();
    const runId = Number(insertRun.run(name, started.toISOString()).lastInsertRowid);

    const lines: string[] = [];
    let bytes = 0;
    let truncated = false;
    const log = (message: string) => {
      if (truncated) return;
      const line = `${new Date().toISOString()} ${message}`;
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > MAX_LOG_BYTES) {
        truncated = true;
        lines.push("[log truncated]");
        return;
      }
      lines.push(line);
    };

    let status: "success" | "failure" = "success";
    try {
      await entry.handler({ log });
    } catch (err) {
      status = "failure";
      const e = err instanceof Error ? err : new Error(String(err));
      log(`ERROR: ${e.stack ?? e.message}`);
    }

    const finished = new Date();
    try {
      if (entry.quiet && status === "success" && lines.length === 0) {
        deleteRun.run(runId); // nothing happened: do not clutter the run history
      } else {
        finishRun.run(
          finished.toISOString(),
          status,
          finished.getTime() - started.getTime(),
          lines.join("\n"),
          runId,
        );
      }
      touchJob.run(started.toISOString(), iso(entry.cron.nextRun()), status, name);
    } catch (dbErr) {
      // Bookkeeping must never take the server down either.
      console.error(`[runner] failed to record run for ${name}:`, (dbErr as Error).message);
    }
    console.log(`[runner] ${name} ${status} in ${finished.getTime() - started.getTime()}ms`);
    return { status, runId };
  } finally {
    running.delete(name);
  }
}

export function registerJob(name: string, cronExpression: string, handler: JobHandler, options: JobOptions = {}): void {
  if (registry.has(name)) throw new Error(`job already registered: ${name}`);

  const cron = new Cron(
    cronExpression,
    { name, protect: true, timezone: options.timezone, catch: (e) => console.error(`[runner] ${name} crashed:`, e) },
    async () => {
      await execute(name);
    },
  );
  registry.set(name, { cron, handler, quiet: options.quiet ?? false, expression: cronExpression, timezone: options.timezone ?? null });

  upsertJob.run(name, cronExpression);
  setNext.run(iso(cron.nextRun()), name);
  console.log(`[runner] registered ${name} (${cronExpression})`);
}

/** Start a registered job now and return immediately (used by the webhook). */
export function triggerJob(name: string): boolean {
  if (!registry.has(name)) return false;
  void execute(name);
  return true;
}

/**
 * Run a registered job now and wait for it to finish (used by the dashboard button).
 * Returns the id of the run, or null if the job is unknown, disabled or already running.
 */
export async function runJobNow(name: string): Promise<number | null> {
  return (await execute(name)).runId;
}

/** The jobs this server is scheduling right now (read-only, for the dashboard's stale-job check). */
export function listRegisteredJobs(): { name: string; cron: string; timezone: string | null; intervalMs: number }[] {
  return [...registry.entries()].map(([name, r]) => {
    const [a, b] = r.cron.nextRuns(2);
    return { name, cron: r.expression, timezone: r.timezone, intervalMs: a && b ? b.getTime() - a.getTime() : 0 };
  });
}

export function stopAllJobs(): void {
  for (const { cron } of registry.values()) cron.stop();
}
