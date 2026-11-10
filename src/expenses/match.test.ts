import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { storeEmailExpense, type EmailPurchase } from "./email";
import { betterMerchant, isMessyMerchant, sameMerchant, type EmailKind } from "./match";
import { createExpenseTables } from "./schema";
import type { SheetsClient } from "./sheets";
import { storeExpense } from "./store";
import { syncExpenses } from "./sync";

const NOW = new Date("2026-11-10T02:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR);

/** A Wallet tap. `when` is the purchase time inside raw_data; `now` is when the webhook received it. */
const tap = (db: Database.Database, merchant: string, amount: string, hoursFromNow: number, card = "Visa") =>
  storeExpense(
    db,
    { raw_data: { Merchant: merchant, Amount: amount, "Card or Pass": card, Date: at(hoursFromNow).toISOString() } },
    at(hoursFromNow),
  );

let seq = 0;
const email = (
  merchant: string,
  dollars: number,
  hoursFromNow: number,
  currency = "AUD",
  kind: EmailKind | null = null,
): EmailPurchase => ({
  kind,
  messageId: `msg-${++seq}`,
  merchant,
  amount_cents: Math.round(dollars * 100),
  currency,
  occurred_at: at(hoursFromNow).toISOString(),
});

/** Rows that are real expenses (not ignored duplicates). */
const real = (db: Database.Database) =>
  db.prepare(`SELECT * FROM expenses WHERE sheet_status != 'duplicate' ORDER BY id`).all() as Record<string, unknown>[];
const all = (db: Database.Database) => db.prepare(`SELECT * FROM expenses ORDER BY id`).all() as Record<string, unknown>[];

describe("tap + email matching", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    createExpenseTables(db);
  });

  it("tap then email: merges into the tap, no second expense", () => {
    tap(db, "Cafe", "$12.50", 0);
    const r = storeEmailExpense(db, email("Cafe", 12.5, 3), at(3));
    assert.equal(r.outcome, "merged");
    assert.equal(real(db).length, 1);
    assert.equal(all(db).length, 1, "nothing inserted for the email");
    const row = real(db)[0];
    assert.match(String(row.email_message_id), /^msg-/);
    assert.ok(row.merged_at);
    assert.equal(row.source, "tap");
  });

  it("email then tap: the tap does not add a second expense", () => {
    const e = email("Daily Grind", 12.5, 0);
    assert.equal(storeEmailExpense(db, e, at(0)).outcome, "added");
    const t = tap(db, "SQ *GRIND 1234", "$12.50", 2);
    assert.equal(t.outcome, "merged");
    assert.equal(real(db).length, 1);
    const rows = all(db);
    assert.equal(rows.length, 2, "the tap is recorded as ignored");
    assert.equal(rows[1].sheet_status, "duplicate");
    assert.equal(rows[1].duplicate_of, rows[0].id);
    assert.ok(rows[0].merged_at);
    assert.equal(rows[0].merchant, "Daily Grind", "the clean email name stays");
  });

  it("two genuinely different purchases with the same amount on different days stay separate", () => {
    tap(db, "Cafe", "$12.50", 0);
    const r = storeEmailExpense(db, email("Cafe", 12.5, 72), at(72)); // 3 days later
    assert.equal(r.outcome, "added");
    assert.equal(real(db).length, 2);

    // and the other way round
    const t = tap(db, "Cafe", "$12.50", 200);
    assert.equal(t.outcome, "stored");
    assert.equal(real(db).length, 3);
  });

  it("different amount or currency never matches", () => {
    tap(db, "Cafe", "$12.50", 0);
    assert.equal(storeEmailExpense(db, email("Cafe", 12.51, 1), at(1)).outcome, "added");
    assert.equal(storeEmailExpense(db, email("Cafe", 12.5, 1, "USD"), at(1)).outcome, "added");
  });

  it("the window is 48 hours either side", () => {
    tap(db, "Cafe", "$5.00", 0);
    assert.equal(storeEmailExpense(db, email("Cafe", 5, 47), at(47)).outcome, "merged");
    tap(db, "Shop", "$9.00", 0);
    assert.equal(storeEmailExpense(db, email("Shop", 9, -49), at(1)).outcome, "added");
  });

  it("the same email processed twice is one expense", () => {
    const e = email("Cafe", 12.5, 0);
    assert.equal(storeEmailExpense(db, e, at(0)).outcome, "added");
    assert.equal(storeEmailExpense(db, e, at(1)).outcome, "already");
    assert.equal(all(db).length, 1);
    // and after it merged into a tap
    const t = email("Bakery", 4, 0);
    tap(db, "Bakery", "$4.00", 0);
    assert.equal(storeEmailExpense(db, t, at(0)).outcome, "merged");
    assert.equal(storeEmailExpense(db, t, at(1)).outcome, "already");
    assert.equal(real(db).length, 2);
  });

  it("each expense is matched once: a second same-amount email does not steal a merged tap", () => {
    tap(db, "Cafe", "$4.50", 0);
    tap(db, "Cafe", "$4.50", 24); // next day, a real second coffee
    assert.equal(storeEmailExpense(db, email("Cafe", 4.5, 1), at(1)).outcome, "merged"); // tap 1 (closest)
    assert.equal(storeEmailExpense(db, email("Cafe", 4.5, 25), at(25)).outcome, "merged"); // tap 2
    // a third email has no tap left to merge into, so it is its own expense
    assert.equal(storeEmailExpense(db, email("Cafe", 4.5, 26), at(26)).outcome, "added");
    assert.equal(real(db).length, 3);
  });

  it("two taps of one purchase arriving within 2 minutes still dedupe as before", () => {
    assert.equal(tap(db, "Cafe", "$12.50", 0).outcome, "stored");
    assert.equal(storeExpense(db, { raw_data: { Merchant: "Cafe", Amount: "$12.50", "Card or Pass": "Visa" } }, new Date(at(0).getTime() + 60_000)).outcome, "duplicate");
  });

  it("two emails for one purchase arriving together are one expense", () => {
    assert.equal(storeEmailExpense(db, email("Cafe", 12.5, 0), at(0)).outcome, "added");
    const second = storeEmailExpense(db, email("Cafe", 12.5, 0), new Date(at(0).getTime() + 30_000));
    assert.equal(second.outcome, "duplicate");
    assert.equal(real(db).length, 1);
  });

  it("only the extracted fields are stored for an email expense", () => {
    storeEmailExpense(db, email("Cafe", 12.5, 0), at(0));
    const raw = String(all(db)[0].raw_payload);
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["amount_cents", "currency", "kind", "merchant", "occurred_at", "source"]);
  });
});

describe("invoice + receipt emails for one charge", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    createExpenseTables(db);
  });

  it("an invoice and its receipt are one expense, whichever arrives first", () => {
    assert.equal(storeEmailExpense(db, email("Cloudflare", 11.17, 0, "USD", "invoice"), at(0)).outcome, "added");
    const r = storeEmailExpense(db, email("Cloudflare, Inc.", 11.17, 3, "USD", "receipt"), at(1));
    assert.equal(r.outcome, "duplicate");
    assert.equal(r.outcome === "duplicate" && r.why, "pair");
    assert.equal(real(db).length, 1);

    assert.equal(storeEmailExpense(db, email("Vercel", 20, 0, "USD", "receipt"), at(0)).outcome, "added");
    assert.equal(storeEmailExpense(db, email("Vercel", 20, 50, "USD", "invoice"), at(50)).outcome, "duplicate");
    assert.equal(real(db).length, 2);
  });

  it("a receipt merged into a tap still pairs with its invoice", () => {
    tap(db, "CLOUDFLARE 123", "$11.17", 0);
    assert.equal(storeEmailExpense(db, email("Cloudflare", 11.17, 1, "AUD", "receipt"), at(1)).outcome, "merged");
    assert.equal(storeEmailExpense(db, email("Cloudflare", 11.17, 1, "AUD", "invoice"), at(1)).outcome, "duplicate");
    assert.equal(real(db).length, 1);
  });

  it("two genuine receipts for the same merchant and amount stay two expenses", () => {
    assert.equal(storeEmailExpense(db, email("McDonald's", 19.95, 0, "AUD", "receipt"), at(0)).outcome, "added");
    assert.equal(storeEmailExpense(db, email("McDonald's", 19.95, 24, "AUD", "receipt"), at(24)).outcome, "added");
    assert.equal(real(db).length, 2);
  });

  it("the same email sent twice (same timestamp) is a repeat", () => {
    storeEmailExpense(db, email("Cafe", 5, 0, "AUD", "receipt"), at(0));
    const r = storeEmailExpense(db, email("Cafe", 5, 0, "AUD", "receipt"), at(5));
    assert.equal(r.outcome === "duplicate" && r.why, "repeat");
  });

  it("different merchants, or unknown kinds, never pair", () => {
    storeEmailExpense(db, email("Cloudflare", 11.17, 0, "USD", "invoice"), at(0));
    assert.equal(storeEmailExpense(db, email("Vercel", 11.17, 1, "USD", "receipt"), at(1)).outcome, "added");
    assert.equal(storeEmailExpense(db, email("Cloudflare", 11.17, 1, "USD", null), at(1)).outcome, "added");
  });

  it("merchant names are compared loosely", () => {
    assert.ok(sameMerchant("Cloudflare", "Cloudflare, Inc."));
    assert.ok(sameMerchant("SQ *CLOUDFLARE 123", "Cloudflare"));
    assert.ok(!sameMerchant("Cloudflare", "Vercel"));
    assert.ok(!sameMerchant("ab", "abc"));
  });
});

describe("merchant names", () => {
  it("recognises messy terminal strings", () => {
    assert.ok(isMessyMerchant("SQ *CAFE 1234"));
    assert.ok(isMessyMerchant("WOOLWORTHS 4521 SYDNEY"));
    assert.ok(isMessyMerchant("AMAZON"));
    assert.ok(!isMessyMerchant("Smiling Mind"));
  });
  it("only replaces a messy name with a clean one", () => {
    assert.equal(betterMerchant("SQ *CAFE 1234", "Daily Grind"), "Daily Grind");
    assert.equal(betterMerchant("Smiling Mind", "Smiling Mind Ltd"), null);
    assert.equal(betterMerchant("SQ *CAFE 1234", "SQ *OTHER 999"), null);
    assert.equal(betterMerchant("SQ *CAFE 1234", "  "), null);
  });

  describe("in the database and the Sheet", () => {
    let db: Database.Database;
    beforeEach(() => {
      db = new Database(":memory:");
      createExpenseTables(db);
    });
    const fakeSheet = () => {
      const rows: (string | number)[][] = [];
      const updates: [number, string][] = [];
      const client: SheetsClient = {
        findRow: async (m) => {
          const i = rows.findIndex((r) => r[5] === m);
          return i === -1 ? null : i + 2;
        },
        appendRow: async (v) => {
          rows.push(v);
          return rows.length + 1;
        },
        setMerchant: async (row, m) => {
          updates.push([row, m]);
        },
      };
      return { client, rows, updates };
    };

    it("a merged email improves a messy tap merchant and the Sheet gets just that cell", async () => {
      tap(db, "SQ *GRIND 1234", "$12.50", 0);
      const sheet = fakeSheet();
      await syncExpenses({ db, sheets: sheet.client, log: () => {} }); // tap is in the Sheet now
      assert.equal(sheet.rows.length, 1);

      const r = storeEmailExpense(db, email("Daily Grind", 12.5, 1), at(1));
      assert.equal(r.outcome === "merged" && r.merchantImproved, true);
      await syncExpenses({ db, sheets: sheet.client, log: () => {} });
      assert.equal(sheet.rows.length, 1, "no new row");
      assert.deepEqual(sheet.updates, [[2, "Daily Grind"]]);

      await syncExpenses({ db, sheets: sheet.client, log: () => {} });
      assert.equal(sheet.updates.length, 1, "updated once only");
    });

    it("a merge with no better name writes nothing to the Sheet", async () => {
      tap(db, "Cafe", "$12.50", 0);
      const sheet = fakeSheet();
      await syncExpenses({ db, sheets: sheet.client, log: () => {} });
      storeEmailExpense(db, email("Cafe Pty Ltd", 12.5, 1), at(1));
      await syncExpenses({ db, sheets: sheet.client, log: () => {} });
      assert.equal(sheet.rows.length, 1);
      assert.deepEqual(sheet.updates, []);
    });

    it("a merge into a tap not yet in the Sheet just carries the better name when it is written", async () => {
      tap(db, "SQ *GRIND 1234", "$12.50", 0);
      storeEmailExpense(db, email("Daily Grind", 12.5, 1), at(1));
      const sheet = fakeSheet();
      await syncExpenses({ db, sheets: sheet.client, log: () => {} });
      assert.equal(sheet.rows[0][1], "Daily Grind");
      assert.deepEqual(sheet.updates, []);
    });

    it("an email-only expense is written with Source = email", async () => {
      storeEmailExpense(db, email("Daily Grind", 12.5, 0), at(0));
      const sheet = fakeSheet();
      await syncExpenses({ db, sheets: sheet.client, log: () => {} });
      assert.equal(sheet.rows[0][6], "email");
      assert.equal(sheet.rows[0][4], "Email receipt");
    });
  });
});
