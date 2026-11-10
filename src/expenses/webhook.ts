import type Database from "better-sqlite3";
import type { WebhookHandler } from "../webhooks";
import { storeExpense } from "./store";

// Rule: never lose a tap. Whatever the Shortcut sends is stored. If we cannot read a merchant and
// amount out of "raw_data" the expense is kept as 'unparsed' and shows in red on the status page.
// (Only a bad secret, or a body over 64 KB, is refused, in app.ts.)

const LOG_FIRST = 20; // always log the raw body of the first expenses, so we can tune the parser
const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}...[cut]` : s);

export function createExpenseWebhook(opts: {
  db: Database.Database;
  /** Called after a new expense is stored (used to start a sync). */
  onStored: () => void;
}): WebhookHandler {
  const { db } = opts;
  return ({ body, rawText, log }) => {
    const seen = (db.prepare(`SELECT COUNT(*) AS n FROM expenses`).get() as { n: number }).n;
    const stored = storeExpense(db, body === undefined ? { non_json_body: rawText } : body);

    // After the first few, only log the bodies we could not read.
    if (seen < LOG_FIRST || stored.outcome === "unparsed") log(`raw body: ${clip(rawText)}`);
    log(`expense #${stored.id}: ${stored.outcome}${stored.duplicateOf ? ` of #${stored.duplicateOf}` : ""}`);
    if (stored.outcome === "stored") opts.onStored();
    return { status: 202, body: { ok: true, id: stored.id, status: stored.outcome } };
  };
}
