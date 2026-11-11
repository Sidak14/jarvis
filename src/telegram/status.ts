import type Database from "better-sqlite3";
import { config } from "../config";
import { esc } from "../html";
import { ago } from "./format";
import { getState } from "./state";

/** The "Telegram" block of the status page. */
export function telegramSection(db: Database.Database, now = new Date()): string {
  const configured = Boolean(config.TELEGRAM_BOT_TOKEN);
  const owner = config.TELEGRAM_OWNER_ID !== undefined;
  const pollOk = getState(db, "last_poll_ok_at");
  const pollError = getState(db, "last_poll_error");

  const connection = !configured
    ? `<span class="failure">Not configured</span> (set TELEGRAM_BOT_TOKEN in .env)`
    : !owner
      ? `<span class="pending">Waiting for TELEGRAM_OWNER_ID</span>: message /start to the bot, copy the id it replies with into .env, restart`
      : pollError
        ? `<span class="failure">Not connected</span>: ${esc(pollError)}`
        : pollOk && now.getTime() - Date.parse(pollOk) < 120_000
          ? `<span class="success">Connected</span>${getState(db, "bot_username") ? ` as @${esc(getState(db, "bot_username"))}` : ""}`
          : `<span class="pending">Starting...</span>`;

  const outbox = db
    .prepare(`SELECT COALESCE(SUM(status = 'pending'), 0) AS pending, COALESCE(SUM(status = 'failed'), 0) AS failed, MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest FROM outbox`)
    .get() as { pending: number; failed: number; oldest: string | null };
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const asked = (db.prepare(`SELECT COUNT(*) AS n FROM expenses WHERE asked_at >= ?`).get(weekAgo) as { n: number }).n;
  const answered = (db.prepare(`SELECT COUNT(*) AS n FROM expenses WHERE answered_at >= ?`).get(weekAgo) as { n: number }).n;
  const bySource = (source: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM expenses WHERE category_source = ? AND received_at >= ?`).get(source, weekAgo) as { n: number }).n;
  const uncategorised = (
    db.prepare(`SELECT COUNT(*) AS n FROM expenses WHERE category IS NULL AND parse_status = 'ok' AND sheet_status NOT IN ('duplicate','unparsed')`).get() as { n: number }
  ).n;
  const lastError = getState(db, "last_send_error");

  const questions = config.TELEGRAM_QUESTIONS_ENABLED
    ? `<strong class="success">ON</strong> (AI picks a category; I ask you when it is unsure. Non-urgent messages wait until 9am-11pm Sydney)`
    : `<strong class="pending">OFF</strong> (set TELEGRAM_QUESTIONS_ENABLED=true after the test message arrives)`;

  return `<h2>Telegram</h2>
<p>Bot: ${connection}<br>
   Last message received: ${esc(ago(getState(db, "last_received_at"), now))} · sent: ${esc(ago(getState(db, "last_sent_at"), now))}<br>
   Outbox: <strong class="${outbox.pending ? "pending" : "success"}">${outbox.pending} pending</strong>${outbox.pending && outbox.oldest ? ` (oldest ${esc(ago(outbox.oldest, now))})` : ""} · <strong class="${outbox.failed ? "failure" : "success"}">${outbox.failed} failed</strong><br>
   Questions: ${questions}<br>
   This week: ${asked} asked, ${answered} answered<br>
   Categories this week: ${bySource("ai")} by AI · ${bySource("history")} by repeat merchant · ${bySource("owner")} by you · ${uncategorised} uncategorised in total</p>
${lastError && (outbox.pending || outbox.failed) ? `<p class="failure"><strong>Last send error:</strong> ${esc(lastError)}</p>` : ""}`;
}
