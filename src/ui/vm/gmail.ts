import { JOB_NAME, LOOKBACK_DAYS, POLL_CRON } from "../../gmail/settings";
import { scheduleToWords } from "../format";
import { buildAiUsage, type AiUsageVM } from "./ai";
import type { UiContext } from "./types";

// The Invoices (Gmail) page: connection, last run vs all time, AI usage and the processed-emails table.

export type EmailResult = "invoice" | "not_invoice" | "error";

export interface EmailRowVM {
  messageId: string;
  processedAt: Date;
  result: EmailResult;
  detail: string;
  dryRun: boolean;
}
export interface GmailVM {
  configured: boolean;
  connected: boolean;
  dryRun: boolean;
  scheduleText: string;
  lookbackDays: number;
  lastRun: { at: Date; status: "success" | "failure"; dryRun: boolean; checked: number; invoices: number; added: number; merges: number; errors: number; lastError: string | null; aiBlocked: string | null } | null;
  allTime: { checked: number; invoices: number; added: number; merged: number; errors: number; notInvoice: number };
  ai: AiUsageVM;
  aiConfigured: boolean;
  emails: EmailRowVM[];
  filter: EmailResult | null;
  run: { id: number; status: string; startedAt: Date; durationMs: number | null; log: string } | null;
  jobName: string;
}

interface State {
  last_run_at: string;
  last_status: string;
  dry_run: number;
  checked: number;
  invoices: number;
  merges: number;
  added: number;
  errors: number;
  last_error: string | null;
  ai_blocked: string | null;
}

export function buildGmail(ctx: UiContext, opts: { filter?: string | null; runId?: number } = {}): GmailVM {
  const { db, now, flags } = ctx;
  const state = db.prepare(`SELECT * FROM gmail_state WHERE id = 1`).get() as State | undefined;
  const totals = Object.fromEntries(
    (db.prepare(`SELECT result, COUNT(*) AS n FROM processed_emails GROUP BY result`).all() as { result: string; n: number }[]).map((r) => [r.result, r.n]),
  ) as Record<string, number | undefined>;
  const added = (db.prepare(`SELECT COUNT(*) AS n FROM expenses WHERE source = 'email' AND sheet_status != 'duplicate'`).get() as { n: number }).n;
  const merged = (db.prepare(`SELECT COUNT(*) AS n FROM expenses WHERE merged_at IS NOT NULL`).get() as { n: number }).n;
  const filter: EmailResult | null = opts.filter === "invoice" || opts.filter === "not_invoice" || opts.filter === "error" ? opts.filter : null;
  const emails = (
    filter
      ? db.prepare(`SELECT message_id, processed_at, result, detail, dry_run FROM processed_emails WHERE result = ? ORDER BY processed_at DESC, rowid DESC LIMIT 60`).all(filter)
      : db.prepare(`SELECT message_id, processed_at, result, detail, dry_run FROM processed_emails ORDER BY processed_at DESC, rowid DESC LIMIT 60`).all()
  ) as { message_id: string; processed_at: string; result: string; detail: string | null; dry_run: number }[];
  const run = (
    opts.runId && Number.isInteger(opts.runId) && opts.runId > 0
      ? db.prepare(`SELECT * FROM runs WHERE id = ? AND job = ?`).get(opts.runId, JOB_NAME)
      : db.prepare(`SELECT * FROM runs WHERE job = ? ORDER BY id DESC LIMIT 1`).get(JOB_NAME)
  ) as { id: number; status: string; started_at: string; duration_ms: number | null; log: string | null } | undefined;

  return {
    configured: flags.gmailConfigured,
    connected: flags.gmailConnected,
    dryRun: flags.gmailDryRun,
    scheduleText: scheduleToWords(POLL_CRON),
    lookbackDays: LOOKBACK_DAYS,
    lastRun: state
      ? { at: new Date(state.last_run_at), status: state.last_status === "success" ? "success" : "failure", dryRun: state.dry_run === 1, checked: state.checked, invoices: state.invoices, added: state.added, merges: state.merges, errors: state.errors, lastError: state.last_error, aiBlocked: state.ai_blocked }
      : null,
    allTime: { checked: (totals.invoice ?? 0) + (totals.not_invoice ?? 0) + (totals.error ?? 0), invoices: totals.invoice ?? 0, added, merged, errors: totals.error ?? 0, notInvoice: totals.not_invoice ?? 0 },
    ai: buildAiUsage(db, now),
    aiConfigured: flags.aiConfigured,
    emails: emails.map((e) => ({ messageId: e.message_id, processedAt: new Date(e.processed_at), result: e.result === "invoice" ? "invoice" : e.result === "error" ? "error" : "not_invoice", detail: e.detail ?? "", dryRun: e.dry_run === 1 })),
    filter,
    run: run ? { id: run.id, status: run.status, startedAt: new Date(run.started_at), durationMs: run.duration_ms, log: run.log ?? "" } : null,
    jobName: JOB_NAME,
  };
}
