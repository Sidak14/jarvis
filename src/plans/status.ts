import path from "node:path";
import type Database from "better-sqlite3";
import { MONTHLY_SPEND_CAP_USD } from "../ai/settings";
import { aiSpendThisMonth } from "../ai/usage";
import { config } from "../config";
import { esc } from "../html";
import { ago } from "../telegram/format";
import { loadAllowlist } from "./allowlist";
import { getState } from "./store";

function calendarState(db: Database.Database): string {
  const connected = !!db.prepare(`SELECT 1 FROM calendar_auth`).get();
  return connected ? `<span class="success">connected</span>` : `<span class="pending">not connected</span> (<a href="/calendar/login">log in</a>)`;
}

/** The "Plans" block of the status page (also shown at the top of /plans). */
export function plansSection(db: Database.Database, now = new Date()): string {
  const dataDir = path.dirname(config.DB_PATH);
  const configured = Boolean(config.BEEPER_ACCESS_TOKEN);
  const error = getState(db, "last_error");
  const lastOk = getState(db, "last_poll_ok_at");
  const connection = !configured
    ? `<span class="pending">Not configured</span> (set BEEPER_ACCESS_TOKEN in .env)`
    : error
      ? `<span class="failure">Not connected</span>: ${esc(error)}`
      : lastOk
        ? `<span class="success">Connected</span> (${esc(getState(db, "accounts") ?? "?")} accounts, last poll ${esc(ago(lastOk, now))})`
        : `<span class="pending">Starting...</span>`;
  const allow = loadAllowlist(dataDir);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const found = (db.prepare(`SELECT COUNT(*) AS n FROM plans WHERE created_at >= ?`).get(weekAgo) as { n: number }).n;
  const pending = (db.prepare(`SELECT COUNT(*) AS n FROM plan_messages WHERE status = 'pending'`).get() as { n: number }).n;
  const spend = aiSpendThisMonth(db, now);
  const mode = config.PLANS_DRY_RUN ? `<strong class="pending">DRY RUN</strong> (calendar and pings are off)` : `<strong class="success">LIVE</strong>`;
  const runError = getState(db, "last_run_error");

  return `<h2>Plans</h2>
<p>Beeper: ${connection}<br>
   Mode: ${mode} · reading ${config.PLANS_ALL_CHATS ? "<strong>all Instagram chats</strong>" : `${allow.chats.length} allowlisted chat(s)`}${allow.error ? ` <span class="failure">${esc(allow.error)}</span>` : ""}<br>
   Last batch: ${esc(getState(db, "last_batch_summary") ?? "none yet")} (${esc(ago(getState(db, "last_batch_at"), now))})<br>
   Plans found this week: ${found} · messages waiting: ${pending}<br>
   AI spend this month: $${spend.toFixed(2)} of $${MONTHLY_SPEND_CAP_USD} · Calendar: ${calendarState(db)}
   · <a href="/plans">Open the plans page</a></p>
${runError ? `<p class="failure"><strong>Last error:</strong> ${esc(runError)}</p>` : ""}`;
}
