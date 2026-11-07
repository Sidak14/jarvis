import { Cron } from "croner";
import { db } from "./db";

export interface JobContext {
  /** Append a line to this run's captured log. */
  log: (message: string) => void;
}
export type JobHandler = (ctx: JobContext) => void | Promise<void>;

interface Registered {
  cron: Cron;
  handler: JobHandler;
}

const MAX_LOG_BYTES = 64 * 1024;
const registry = new Map<string, Registered>();

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
const touchJob = db.prepare(
  `UPDATE jobs SET last_run_at = ?, next_run_at = ? WHERE name = ?`,
);
const setNext = db.prepare(`UPDATE jobs SET next_run_at = ? WHERE name = ?`);

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

async function execute(name: string): Promise<"success" | "failure" | "skipped"> {
  const entry = registry.get(name);
  if (!entry) return "skipped";

  const row = getEnabled.get(name) as { enabled: number } | undefined;
  if (row && row.enabled === 0) return "skipped";

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
    finishRun.run(
      finished.toISOString(),
      status,
      finished.getTime() - started.getTime(),
      lines.join("\n"),
      runId,
    );
    touchJob.run(started.toISOString(), iso(entry.cron.nextRun()), name);
  } catch (dbErr) {
    // Bookkeeping must never take the server down either.
    console.error(`[runner] failed to record run for ${name}:`, (dbErr as Error).message);
  }
  console.log(`[runner] ${name} ${status} in ${finished.getTime() - started.getTime()}ms`);
  return status;
}

export function registerJob(name: string, cronExpression: string, handler: JobHandler): void {
  if (registry.has(name)) throw new Error(`job already registered: ${name}`);

  const cron = new Cron(
    cronExpression,
    { name, protect: true, catch: (e) => console.error(`[runner] ${name} crashed:`, e) },
    async () => {
      await execute(name);
    },
  );
  registry.set(name, { cron, handler });

  upsertJob.run(name, cronExpression);
  setNext.run(iso(cron.nextRun()), name);
  console.log(`[runner] registered ${name} (${cronExpression})`);
}

/** Run a registered job right now (used by the webhook). Returns false if unknown. */
export function triggerJob(name: string): boolean {
  if (!registry.has(name)) return false;
  void execute(name);
  return true;
}

export function stopAllJobs(): void {
  for (const { cron } of registry.values()) cron.stop();
}
