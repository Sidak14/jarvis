import type Database from "better-sqlite3";
import { money, oneLine } from "./format";
import { CATEGORIES, MAX_PURPOSE_CHARS, SKIP_NUMBER } from "./settings";
import { formatWhen } from "./time";

// "What was this for?" The question is plain text with a numbered list (no buttons, because some
// chat apps do not show them). The owner replies to the question with a number.
// Everything the owner types is stored as data (text), never interpreted.

export interface QuestionExpense {
  id: number;
  merchant: string;
  amount_cents: number;
  currency: string;
  occurred_at: string;
}

export function questionText(e: QuestionExpense, now: Date): string {
  return [
    `${money(e.amount_cents, e.currency)} at ${oneLine(e.merchant, 60)}, ${formatWhen(new Date(e.occurred_at), now)}. What was this for?`,
    "Reply with:",
    ...CATEGORIES.map((c, i) => `${i + 1}. ${c.label}`),
    `${SKIP_NUMBER}. Skip`,
    "Anything else you type is saved as Other, with your words as the note.",
  ].join("\n");
}

/** Expense that this question message (Telegram message id) was about. */
export function findExpenseByQuestionMessage(db: Database.Database, messageId: number): number | undefined {
  return (db.prepare(`SELECT id FROM expenses WHERE question_message_id = ?`).get(messageId) as { id: number } | undefined)?.id;
}

/** Called once Telegram has accepted a question: remember which message asked about which expense. */
export function attachQuestionMessage(db: Database.Database, expenseId: number, messageId: number): void {
  db.prepare(`UPDATE expenses SET question_message_id = ? WHERE id = ?`).run(messageId, expenseId);
}

/** A purpose is plain text: control characters removed, clipped. It is stored, never executed. */
export const cleanPurpose = (text: string) => text.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, MAX_PURPOSE_CHARS);

/** "2" or "2." means choice 2. Returns null for anything else (that is a note, not a choice). */
export function parseChoice(text: string): number | null {
  const m = /^(\d{1,3})[.)]?$/.exec(text.trim());
  return m ? Number(m[1]) : null;
}

export type ReplyResult =
  | { result: "category"; category: string }
  | { result: "skipped" }
  | { result: "purpose"; purpose: string }
  | { result: "already" }
  | { result: "bad_number" }
  | { result: "not_found" };

/**
 * The owner replied to a question. A number picks the category (or Skip); any other text is
 * saved as Other with that text as the purpose. Once the category is set, a further text reply
 * adds the purpose. Each thing can be set once. The Sheet is updated later by the sync job.
 */
export function applyReply(db: Database.Database, expenseId: number, text: string, now = new Date()): ReplyResult {
  const row = db.prepare(`SELECT category, purpose, answered_at FROM expenses WHERE id = ?`).get(expenseId) as
    | { category: string | null; purpose: string | null; answered_at: string | null }
    | undefined;
  if (!row) return { result: "not_found" };
  const at = now.toISOString();
  const choice = parseChoice(text);

  if (row.category !== null) {
    // Already categorised (by you, the AI, or an earlier reply): only a note can still be added.
    const note = cleanPurpose(text);
    if (choice !== null || !note || row.purpose !== null) return { result: "already" };
    db.prepare(`UPDATE expenses SET purpose = ?, answered_at = COALESCE(answered_at, ?) WHERE id = ?`).run(note, at, expenseId);
    return { result: "purpose", purpose: note };
  }

  if (choice === SKIP_NUMBER) {
    if (row.answered_at !== null) return { result: "already" };
    db.prepare(`UPDATE expenses SET answered_at = ? WHERE id = ?`).run(at, expenseId);
    return { result: "skipped" };
  }
  if (choice !== null) {
    const category = CATEGORIES[choice - 1]?.label;
    if (!category) return { result: "bad_number" };
    setCategory(db, expenseId, category, "owner", now);
    return { result: "category", category };
  }

  const note = cleanPurpose(text);
  if (!note) return { result: "already" };
  setCategory(db, expenseId, "Other", "owner", now);
  if (row.purpose === null) db.prepare(`UPDATE expenses SET purpose = ? WHERE id = ?`).run(note, expenseId);
  return { result: "category", category: "Other" };
}

/** Save a category (only if there is none yet). source: 'owner' | 'ai' | 'history'. */
export function setCategory(db: Database.Database, expenseId: number, category: string, source: string, now = new Date()): boolean {
  return (
    db
      .prepare(
        `UPDATE expenses SET category = ?, category_source = ?, answered_at = COALESCE(answered_at, ?)
          WHERE id = ? AND category IS NULL`,
      )
      .run(category, source, now.toISOString(), expenseId).changes > 0
  );
}

/** /recat <id> <number>: the owner changes a category. Returns the new label, or null if there is no such expense/number. */
export function recategorise(db: Database.Database, expenseId: number, choice: number, now = new Date()): string | null {
  const category = CATEGORIES[choice - 1]?.label;
  if (!category) return null;
  const changed = db
    .prepare(
      `UPDATE expenses SET category = ?, category_source = 'owner', answered_at = COALESCE(answered_at, ?)
        WHERE id = ? AND sheet_status NOT IN ('duplicate', 'unparsed')`,
    )
    .run(category, now.toISOString(), expenseId).changes;
  return changed > 0 ? category : null;
}
