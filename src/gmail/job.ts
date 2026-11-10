import type Database from "better-sqlite3";
import { AiCapError, type Llm } from "../ai/llm";
import {
  decideEmailExpense,
  newPreview,
  notePreview,
  storeEmailExpense,
  type EmailDecision,
  type EmailPurchase,
} from "../expenses/email";
import { ExtractionError, extract, validateExtraction } from "./extract";
import { GmailError, type GmailClient } from "./client";
import { prefilter } from "./filter";
import { LIST_LIMIT, LOOKBACK_DAYS, MAX_EMAILS_PER_RUN, SEARCH_QUERY } from "./settings";

export interface GmailExpensesDeps {
  db: Database.Database;
  gmail: GmailClient;
  llm: Llm;
  dryRun: boolean;
  log: (message: string) => void;
  /** Called when expenses were added or changed, so the Sheet sync can run now. */
  onChanged?: () => void;
  now?: Date;
}

export interface GmailRunSummary {
  checked: number;
  invoices: number;
  added: number;
  merges: number;
  errors: number;
}

const money = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency}`;

function describe(d: EmailDecision, e: EmailPurchase): string {
  const what = `${e.merchant} ${money(e.amount_cents, e.currency)} on ${e.occurred_at.slice(0, 10)}`;
  switch (d.kind) {
    case "add":
      return `add ${what}`;
    case "merge":
      return `merge into expense #${d.id} (${d.merchant})${d.newMerchant ? `, rename it to "${d.newMerchant}"` : ""}: ${what}`;
    case "duplicate":
      return `ignore, ${d.why === "pair" ? "the invoice/receipt pair of" : "a repeat of"} expense #${d.id}: ${what}`;
    case "already":
      return `skip, already expense #${d.id}`;
  }
}

/**
 * Read new invoice emails and add them to the expenses pipeline.
 * Steps: Gmail search -> skip ids already processed -> cheap code filter -> LLM extract ->
 * sanity checks -> decide (add / merge / ignore) -> store. The model only fills a schema;
 * everything after that is plain code.
 * Throws at the end if anything stopped the run, so the run shows as a failure.
 */
export async function runGmailExpenses(deps: GmailExpensesDeps): Promise<GmailRunSummary> {
  const { db, gmail, llm, dryRun, log } = deps;
  const now = deps.now ?? new Date();
  const summary: GmailRunSummary = { checked: 0, invoices: 0, added: 0, merges: 0, errors: 0 };
  let stopped: Error | null = null;
  let aiBlocked: string | null = null;
  let changed = false;
  const preview = newPreview(); // dry-run: what this batch would already have created

  const isProcessed = db.prepare(`SELECT 1 FROM processed_emails WHERE message_id = ?`);
  const markProcessed = (id: string, result: "invoice" | "not_invoice" | "error", detail: string, expenseId?: number) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO processed_emails (message_id, processed_at, result, detail, dry_run, expense_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      // Only a dry-run 'invoice' is a preview that must be redone for real; the rest is final.
      .run(id, now.toISOString(), result, detail, dryRun && result === "invoice" ? 1 : 0, expenseId ?? null);

  log(dryRun ? "DRY RUN: nothing will be added, only logged" : "LIVE: invoices will be added to expenses");

  // Dry-run results were only previews. Going live means doing those emails for real.
  if (!dryRun) {
    const redo = db.prepare(`DELETE FROM processed_emails WHERE dry_run = 1`).run().changes;
    if (redo) log(`${redo} email(s) seen in dry-run will be processed for real now`);
  }

  try {
    const ids = await gmail.listMessageIds(SEARCH_QUERY(LOOKBACK_DAYS), LIST_LIMIT);
    const fresh = ids.filter((id) => !isProcessed.get(id));
    const todo = fresh.slice(0, MAX_EMAILS_PER_RUN);
    log(`Gmail matched ${ids.length} email(s) from the last ${LOOKBACK_DAYS} days; ${fresh.length} not processed yet; reading ${todo.length}`);

    for (const id of todo) {
      let email;
      try {
        email = await gmail.getMessage(id);
      } catch (err) {
        if (err instanceof GmailError && err.status === 404) {
          markProcessed(id, "error", "message not found");
          summary.errors++;
          continue;
        }
        throw err;
      }
      summary.checked++;

      const skip = prefilter(email);
      if (skip) {
        markProcessed(id, "not_invoice", `filtered: ${skip}`);
        log(`${id}: skipped (${skip})`);
        continue;
      }

      let extraction;
      try {
        extraction = await extract(llm, email);
      } catch (err) {
        if (err instanceof ExtractionError) {
          markProcessed(id, "error", err.message);
          summary.errors++;
          log(`${id}: ERROR ${err.message}`);
          continue;
        }
        throw err; // cap reached or gateway down: stop, and try this email again next run
      }

      const verdict = validateExtraction(extraction, email.receivedAt, now);
      if (!verdict.ok) {
        if (verdict.kind === "not_invoice") {
          markProcessed(id, "not_invoice", verdict.reason);
          log(`${id}: not an invoice (${verdict.reason})`);
        } else {
          markProcessed(id, "error", `rejected: ${verdict.reason}`);
          summary.errors++;
          log(`${id}: REJECTED (${verdict.reason})`);
        }
        continue;
      }

      summary.invoices++;
      const purchase: EmailPurchase = { messageId: id, ...verdict.purchase };

      if (dryRun) {
        const d = decideEmailExpense(db, purchase, preview);
        notePreview(preview, purchase, d);
        const text = `WOULD ${describe(d, purchase)}`;
        log(`${id}: ${text}`);
        if (d.kind === "merge") summary.merges++;
        else if (d.kind === "add") summary.added++;
        markProcessed(id, "invoice", text);
        continue;
      }

      const r = storeEmailExpense(db, purchase, now);
      if (r.outcome === "added") {
        summary.added++;
        changed = true;
        log(`${id}: added expense #${r.id}: ${purchase.merchant} ${money(purchase.amount_cents, purchase.currency)}`);
        markProcessed(id, "invoice", `added #${r.id}`, r.id);
      } else if (r.outcome === "merged") {
        summary.merges++;
        changed = changed || r.merchantImproved;
        log(`${id}: MERGED into tap expense #${r.id}${r.merchantImproved ? ` (merchant renamed to "${purchase.merchant}")` : ""}`);
        markProcessed(id, "invoice", `merged into #${r.id}`, r.id);
      } else {
        const why = r.outcome === "duplicate" && r.why === "pair" ? "invoice/receipt pair of" : r.outcome === "duplicate" ? "repeat of" : "already";
        log(`${id}: ${why} expense #${r.id}, not added again`);
        markProcessed(id, "invoice", `${why} #${r.id}`, r.id);
      }
    }
  } catch (err) {
    stopped = err instanceof Error ? err : new Error(String(err));
    if (err instanceof AiCapError) aiBlocked = stopped.message;
    log(`STOPPED: ${stopped.message}`);
  }

  log(`checked ${summary.checked}, invoices ${summary.invoices}, ${dryRun ? "would add" : "added"} ${summary.added}, merges ${summary.merges}, errors ${summary.errors}`);

  // Remember this run for the status page, even (especially) if it failed.
  db.prepare(
    `INSERT INTO gmail_state (id, last_run_at, last_status, dry_run, checked, invoices, merges, added, errors, last_error, ai_blocked)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_run_at = excluded.last_run_at, last_status = excluded.last_status,
       dry_run = excluded.dry_run, checked = excluded.checked, invoices = excluded.invoices,
       merges = excluded.merges, added = excluded.added, errors = excluded.errors,
       last_error = excluded.last_error, ai_blocked = excluded.ai_blocked`,
  ).run(
    now.toISOString(),
    stopped ? "failure" : "success",
    dryRun ? 1 : 0,
    summary.checked,
    summary.invoices,
    summary.merges,
    summary.added,
    summary.errors,
    stopped?.message ?? null,
    aiBlocked,
  );

  if (changed) deps.onChanged?.();
  if (stopped) throw stopped;
  return summary;
}
