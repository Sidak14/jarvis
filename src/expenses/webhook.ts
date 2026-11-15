import type Database from "better-sqlite3";
import type { WebhookHandler } from "../webhooks";
import { readableData, storeExpense } from "./store";

// Rule: never lose a tap. Whatever the Shortcut sends is stored. If we cannot read a merchant and
// amount out of "raw_data" the expense is kept as 'unparsed' and shows in red on the status page.
// (Only a bad secret, or a body over 64 KB, is refused, in app.ts.)

const LOG_FIRST = 20; // always log the raw body of the first expenses, so we can tune the parser
const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}...[cut]` : s);

/** Why a tap could not be read, in words for the Telegram alert. */
function unparsedReason(body: unknown, rawText: string): string {
  if (body === undefined) return `the request was not JSON: ${clip(rawText, 200)}`;
  const rawData = readableData(body);
  if (rawData === undefined || rawData === null || (typeof rawData === "string" && rawData.trim() === "")) {
    return "the Shortcut sent no details (the data was empty), so there is no merchant or amount to read";
  }
  return `no merchant and amount found in: ${clip(rawText, 200)}`;
}

export function createExpenseWebhook(opts: {
  db: Database.Database;
  /** Called after a new expense is stored (used to start a sync). */
  onStored: () => void;
  /** Called when a tap was kept but could not be read (used to tell the owner on Telegram). */
  onUnparsed?: (message: string) => void;
}): WebhookHandler {
  const { db } = opts;
  return ({ body, rawText, log }) => {
    const seen = (db.prepare(`SELECT COUNT(*) AS n FROM expenses`).get() as { n: number }).n;
    const stored = storeExpense(db, body === undefined ? { non_json_body: rawText } : body);

    // After the first few, only log the bodies we could not read.
    if (seen < LOG_FIRST || stored.outcome === "unparsed") log(`raw body: ${clip(rawText)}`);
    log(`expense #${stored.id}: ${stored.outcome}${stored.duplicateOf ? ` of #${stored.duplicateOf}` : ""}`);
    if (stored.outcome === "stored") opts.onStored();
    if (stored.outcome === "unparsed") {
      opts.onUnparsed?.(`A card tap came in (expense #${stored.id}) but could not be read: ${unparsedReason(body, rawText)}. It is saved as unparsed on the Expenses page.`);
    }
    return { status: 202, body: { ok: true, id: stored.id, status: stored.outcome } };
  };
}
