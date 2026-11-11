import type Database from "better-sqlite3";
import { MONTHLY_SPEND_CAP_USD } from "../ai/settings";
import { aiCapReason, aiSpendThisMonth } from "../ai/usage";
import { oneLine } from "./format";
import type { Outbox } from "./outbox";
import {
  AI_WARN_FRACTION,
  CONSENT_WARN_DAYS,
  COOLDOWN,
  JOB_FAILURE_STREAK,
  SHEET_ERROR_ATTEMPTS,
  SHEET_STUCK_AFTER_MS,
} from "./settings";

// The "silent failure" fix: look for things that are quietly broken and say so on Telegram.
// Each alert has a key and a cooldown (see notify), so a problem that stays broken does not spam.
// Jarvis cannot alert if the whole Mac mini is down: that needs something outside it.

/** Returns the keys of the alerts that were actually queued this time. */
export function checkAlerts(deps: { db: Database.Database; notify: Outbox["notify"]; now?: Date }): string[] {
  const { db } = deps;
  const now = deps.now ?? new Date();
  const raised: string[] = [];
  const alert = (key: string, cooldownMs: number, text: string) => {
    if (deps.notify(`⚠️ ${text}`, { dedupeKey: key, cooldownMs, canWait: true }) !== null) raised.push(key);
  };

  // 1. Sheet sync: rows stuck for over an hour, or the same error again and again.
  const pending = db
    .prepare(`SELECT COUNT(*) AS n, MIN(received_at) AS oldest FROM expenses WHERE sheet_status IN ('pending','syncing')`)
    .get() as { n: number; oldest: string | null };
  const lastSheetError = db
    .prepare(`SELECT last_error FROM expenses WHERE last_error IS NOT NULL ORDER BY last_attempt_at DESC LIMIT 1`)
    .get() as { last_error: string } | undefined;
  if (pending.n > 0 && pending.oldest && now.getTime() - Date.parse(pending.oldest) > SHEET_STUCK_AFTER_MS) {
    const hours = Math.floor((now.getTime() - Date.parse(pending.oldest)) / 3_600_000);
    alert(
      "sheet-stuck",
      COOLDOWN.sheet,
      `Sheet sync is stuck: ${pending.n} expense(s) have not reached the Sheet for over ${hours}h.${lastSheetError ? ` Last error: ${oneLine(lastSheetError.last_error, 150)}` : ""}`,
    );
  }
  const repeating = db
    .prepare(`SELECT COUNT(*) AS n FROM expenses WHERE last_error IS NOT NULL AND attempts >= ?`)
    .get(SHEET_ERROR_ATTEMPTS) as { n: number };
  if (repeating.n > 0 && lastSheetError) {
    alert("sheet-error", COOLDOWN.sheet, `Sheet sync keeps failing (${repeating.n} expense(s), ${SHEET_ERROR_ATTEMPTS}+ tries): ${oneLine(lastSheetError.last_error, 150)}`);
  }

  // 2. Gmail login problems (expired, revoked, not connected).
  const gmail = db.prepare(`SELECT last_status, last_error FROM gmail_state WHERE id = 1`).get() as
    | { last_status: string; last_error: string | null }
    | undefined;
  if (gmail?.last_status === "failure" && /log in|expired|revoked|token|not connected|consent/i.test(gmail.last_error ?? "")) {
    alert("gmail-auth", COOLDOWN.gmail, `Gmail needs attention: ${oneLine(gmail.last_error, 200)}`);
  }

  // 3. Any consent/login with a known end date that is within 14 days (or already over).
  const consents = db.prepare(`SELECT name, expires_at FROM consents`).all() as { name: string; expires_at: string }[];
  for (const c of consents) {
    const days = (Date.parse(c.expires_at) - now.getTime()) / 86_400_000;
    if (days <= CONSENT_WARN_DAYS) {
      alert(
        `consent-${c.name}`,
        COOLDOWN.consent,
        days <= 0 ? `The ${c.name} login has expired. Log in again.` : `The ${c.name} login expires in ${Math.ceil(days)} day(s). Log in again before then.`,
      );
    }
  }

  // 4. AI spend: 80% of the month's cap, and the caps themselves.
  const spend = aiSpendThisMonth(db, now);
  const month = now.toISOString().slice(0, 7);
  if (spend >= MONTHLY_SPEND_CAP_USD * AI_WARN_FRACTION) {
    alert(`ai-80-${month}`, COOLDOWN.ai80, `AI spend is at $${spend.toFixed(2)} of the $${MONTHLY_SPEND_CAP_USD} monthly cap (${Math.round((spend / MONTHLY_SPEND_CAP_USD) * 100)}%).`);
  }
  const capReason = aiCapReason(db, now);
  if (capReason) {
    alert(`ai-cap-${capReason.startsWith("daily") ? "daily" : "monthly"}-${now.toISOString().slice(0, 10)}`, COOLDOWN.ai, `AI is paused: ${capReason}.`);
  }

  // 5. A job that has failed several runs in a row.
  const failing = db
    .prepare(`SELECT name, consecutive_failures FROM jobs WHERE consecutive_failures >= ? ORDER BY name`)
    .all(JOB_FAILURE_STREAK) as { name: string; consecutive_failures: number }[];
  for (const j of failing) {
    const last = db.prepare(`SELECT log FROM runs WHERE job = ? AND status = 'failure' ORDER BY id DESC LIMIT 1`).get(j.name) as
      | { log: string | null }
      | undefined;
    const reason = (last?.log ?? "").split("\n").find((l) => /ERROR|STOPPED/.test(l)) ?? "";
    alert(`job-${j.name}`, COOLDOWN.job, `Job ${j.name} has failed ${j.consecutive_failures} runs in a row.${reason ? ` ${oneLine(reason.replace(/^\S+\s/, ""), 200)}` : ""}`);
  }

  return raised;
}
