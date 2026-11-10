import type Database from "better-sqlite3";
import { z } from "zod";
import type { WebhookHandler } from "../webhooks";
import { storeExpense } from "./store";

// The Shortcut sends one field: the whole Wallet transaction as "raw_data".
const bodySchema = z.object({
  raw_data: z.any().refine((v) => v !== undefined && v !== null && v !== "", "raw_data is required"),
});

const LOG_FIRST = 20; // log the raw body of the first expenses, so we can tune the parser
const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}...[cut]` : s);

export function createExpenseWebhook(opts: {
  db: Database.Database;
  /** Called after a new expense is stored (used to start a sync). */
  onStored: () => void;
}): WebhookHandler {
  const { db } = opts;
  return ({ body, log }) => {
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      log(`rejected (400). body was: ${clip(JSON.stringify(body) ?? "undefined", 1000)}`);
      return {
        status: 400,
        body: {
          error: "invalid body",
          details: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`),
        },
      };
    }

    const seen = (db.prepare(`SELECT COUNT(*) AS n FROM expenses`).get() as { n: number }).n;
    if (seen < LOG_FIRST) log(`raw body: ${clip(JSON.stringify(body))}`);

    const result = storeExpense(db, parsed.data);
    log(`expense #${result.id}: ${result.outcome}${result.duplicateOf ? ` of #${result.duplicateOf}` : ""}`);
    if (result.outcome === "stored") opts.onStored();
    return { status: 202, body: { ok: true, id: result.id, status: result.outcome } };
  };
}
