import type Database from "better-sqlite3";
import { aiCallsToday, aiSpendThisMonth, aiCapReason } from "../ai/usage";
import { AI_MODEL, DAILY_CALL_CAP, MONTHLY_SPEND_CAP_USD } from "../ai/settings";
import { config } from "../config";
import { esc } from "../html";
import { gmailAuth } from "./index";
import { LOOKBACK_DAYS, POLL_CRON } from "./settings";

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

const fmt = (iso: string) => new Date(iso).toLocaleString("en-AU", { hour12: false });

/** The "Gmail invoices" block, shown on the main status page and on /gmail. */
export function gmailSection(db: Database.Database, now = new Date()): string {
  const state = db.prepare(`SELECT * FROM gmail_state WHERE id = 1`).get() as State | undefined;
  const totals = Object.fromEntries(
    (db.prepare(`SELECT result, COUNT(*) AS n FROM processed_emails GROUP BY result`).all() as { result: string; n: number }[]).map(
      (r) => [r.result, r.n],
    ),
  ) as Record<string, number | undefined>;

  const configured = gmailAuth.isConfigured();
  const connection = !configured
    ? `<span class="failure">Not configured</span> (set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env)`
    : gmailAuth.isConnected()
      ? `<span class="success">Connected</span> (read-only)`
      : `<span class="failure">Not connected</span> - <a href="/gmail/login">log in to Gmail</a>`;
  const mode = config.GMAIL_DRY_RUN
    ? `<strong class="pending">DRY RUN</strong> (logs what it would add, writes no expenses)`
    : `<strong class="success">LIVE</strong> (adds expenses)`;

  const calls = aiCallsToday(db, now);
  const spend = aiSpendThisMonth(db, now);
  const capReason = aiCapReason(db, now);
  const ai = config.AI_GATEWAY_API_KEY
    ? `AI (${esc(AI_MODEL)}): <strong class="${spend >= MONTHLY_SPEND_CAP_USD * 0.8 ? "failure" : ""}">$${spend.toFixed(4)}</strong> of $${MONTHLY_SPEND_CAP_USD} this month (estimate) · ${calls}/${DAILY_CALL_CAP} calls today`
    : `<span class="failure">AI_GATEWAY_API_KEY is not set</span>`;

  const notes: string[] = [];
  if (capReason) {
    notes.push(`<p class="failure"><strong>AI STOPPED:</strong> ${esc(capReason)}. No emails are being read until it resets.</p>`);
  }
  if (state?.last_status === "failure") {
    notes.push(`<p class="failure"><strong>Last Gmail run FAILED</strong> (${esc(fmt(state.last_run_at))}): ${esc(state.last_error ?? "unknown error")}</p>`);
  }
  if (state && state.errors > 0) {
    notes.push(`<p class="failure">${state.errors} email(s) could not be used in the last run (bad model output or failed checks).</p>`);
  }

  const lastRun = state
    ? `Last run: ${esc(fmt(state.last_run_at))} (${state.dry_run ? "dry run" : "live"}, <span class="${state.last_status === "success" ? "success" : "failure"}">${esc(state.last_status)}</span>)<br>
       Emails checked: ${state.checked} · invoices found: ${state.invoices} · ${state.dry_run ? "would add" : "added"}: ${state.added} · merged with a tap: ${state.merges} · errors: ${state.errors}`
    : `<span class="muted">No run yet.</span>`;

  return `<h2>Gmail invoices</h2>
<p>Connection: ${connection}<br>
   Mode: ${mode}<br>
   Schedule: <code>${esc(POLL_CRON)}</code> (hourly), last ${LOOKBACK_DAYS} days<br>
   ${ai}<br>
   ${lastRun}<br>
   <span class="muted">All time: ${totals.invoice ?? 0} invoice, ${totals.not_invoice ?? 0} not invoice, ${totals.error ?? 0} error</span></p>
${notes.join("\n")}`;
}
