import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { parseAmountCents, parseRawData } from "./parse";
import { createExpenseTables } from "./schema";
import { GoogleSheets, SheetsError, type SheetsClient } from "./sheets";
import { storeExpense } from "./store";
import { syncExpenses } from "./sync";
import { createExpenseWebhook } from "./webhook";

const NOW = new Date("2026-11-10T02:00:00.000Z");
const later = (s: number) => new Date(NOW.getTime() + s * 1000);
const tap = (merchant = "Cafe", amount: unknown = "$12.50", card = "Visa") => ({
  raw_data: { Merchant: merchant, Amount: amount, "Card or Pass": card },
});

function newDb() {
  const db = new Database(":memory:");
  createExpenseTables(db);
  return db;
}
const statuses = (db: Database.Database) =>
  (db.prepare(`SELECT sheet_status AS s FROM expenses ORDER BY id`).all() as { s: string }[]).map((r) => r.s);

/** A fake Sheet: remembers rows; can be told to fail. */
function fakeSheets() {
  const rows: (string | number)[][] = [];
  const state = { failNext: 0, failAfterWrite: 0, findCalls: 0 };
  const merchantUpdates: [number, string][] = [];
  const client: SheetsClient = {
    findRow: async (marker) => {
      state.findCalls++;
      const i = rows.findIndex((r) => r[5] === marker);
      return i === -1 ? null : i + 2;
    },
    appendRow: async (values) => {
      if (state.failNext > 0) {
        state.failNext--;
        throw new SheetsError("Google Sheets HTTP 503: down");
      }
      rows.push(values);
      if (state.failAfterWrite > 0) {
        state.failAfterWrite--;
        throw new SheetsError("network error talking to Google (TimeoutError)"); // it did arrive
      }
      return rows.length + 1;
    },
    setMerchant: async (row, merchant) => {
      merchantUpdates.push([row, merchant]);
    },
  };
  return { client, rows, state, merchantUpdates };
}

describe("parse", () => {
  it("parses amounts to integer cents", () => {
    assert.equal(parseAmountCents("$12.50"), 1250);
    assert.equal(parseAmountCents("A$1,234.50"), 123450);
    assert.equal(parseAmountCents("12.50 AUD"), 1250);
    assert.equal(parseAmountCents(12.5), 1250);
    assert.equal(parseAmountCents(0.29), 29);
    assert.equal(parseAmountCents("-4.00"), 400);
    assert.equal(parseAmountCents("abc"), null);
    assert.equal(parseAmountCents(0), null);
  });
  it("reads an object", () => {
    const e = parseRawData(tap().raw_data, NOW.toISOString());
    assert.deepEqual(e, { merchant: "Cafe", amount_cents: 1250, currency: "AUD", card: "Visa", occurred_at: NOW.toISOString() });
  });
  it("reads a JSON string and 'Key: value' text", () => {
    assert.equal(parseRawData(JSON.stringify({ merchant: "A", amount: 3 }), "x")?.amount_cents, 300);
    const e = parseRawData("Merchant: Woolworths\nAmount: $45.10 USD\nCard or Pass: Debit", NOW.toISOString());
    assert.equal(e?.merchant, "Woolworths");
    assert.equal(e?.currency, "USD");
    assert.equal(e?.card, "Debit");
  });
  it("returns null when merchant or amount is missing", () => {
    assert.equal(parseRawData("hello", "x"), null);
    assert.equal(parseRawData({ merchant: "A" }, "x"), null);
  });
  it("uses a valid timestamp from the data", () => {
    const e = parseRawData({ merchant: "A", amount: 1, date: "2026-11-09T10:00:00Z" }, NOW.toISOString());
    assert.equal(e?.occurred_at, "2026-11-09T10:00:00.000Z");
  });
});

describe("storeExpense", () => {
  let db: Database.Database;
  beforeEach(() => (db = newDb()));

  it("stores a readable expense as pending", () => {
    const r = storeExpense(db, tap(), NOW);
    assert.equal(r.outcome, "stored");
    assert.deepEqual(statuses(db), ["pending"]);
  });
  it("ignores the same tap within 2 minutes, but records it", () => {
    storeExpense(db, tap(), NOW);
    const r = storeExpense(db, tap("cafe ", "$12.50", "visa"), later(90));
    assert.equal(r.outcome, "duplicate");
    assert.equal(r.duplicateOf, 1);
    assert.deepEqual(statuses(db), ["pending", "duplicate"]);
  });
  it("treats it as a new expense after 2 minutes, or if anything differs", () => {
    storeExpense(db, tap(), NOW);
    assert.equal(storeExpense(db, tap(), later(121)).outcome, "stored");
    assert.equal(storeExpense(db, tap("Cafe", "$12.60"), later(122)).outcome, "stored");
    assert.equal(storeExpense(db, tap("Cafe", "$12.50", "Mastercard"), later(123)).outcome, "stored");
  });
  it("keeps unreadable bodies as unparsed, and dedupes identical ones", () => {
    assert.equal(storeExpense(db, { raw_data: "garbage" }, NOW).outcome, "unparsed");
    assert.equal(storeExpense(db, { raw_data: "garbage" }, later(5)).outcome, "duplicate");
    assert.equal(storeExpense(db, { raw_data: "other" }, later(6)).outcome, "unparsed");
    assert.deepEqual(statuses(db), ["unparsed", "duplicate", "unparsed"]);
  });
});

describe("webhook handler", () => {
  it("stores everything with 202, keeps unreadable bodies as unparsed, starts a sync once", () => {
    const db = newDb();
    let started = 0;
    const logs: string[] = [];
    const hook = createExpenseWebhook({ db, onStored: () => started++ });
    const call = (body: unknown, rawText = JSON.stringify(body)) =>
      hook({ body, rawText, log: (m) => logs.push(m) }) as { status: number; body: Record<string, unknown> };

    assert.equal(call({ raw_data: "" }).body.status, "unparsed"); // what the phone really sent
    assert.equal(call({}).status, 202);
    assert.equal(call([1]).status, 202);
    assert.equal(call(undefined, "hello, not json").status, 202);
    assert.equal(call(tap()).body.status, "stored");
    assert.equal(call(tap()).body.status, "duplicate"); // still 202
    assert.equal(started, 1);
    assert.deepEqual(statuses(db), ["unparsed", "unparsed", "unparsed", "unparsed", "pending", "duplicate"]);
    assert.ok(logs.some((l) => l.startsWith("raw body:")));
    const rows = db.prepare(`SELECT raw_payload FROM expenses`).pluck().all();
    assert.ok(rows.includes('{"non_json_body":"hello, not json"}'));
  });
});

describe("syncExpenses", () => {
  let db: Database.Database;
  let logs: string[];
  const log = (m: string) => logs.push(m);
  beforeEach(() => {
    db = newDb();
    logs = [];
  });

  it("writes pending expenses and marks them synced with their row", async () => {
    storeExpense(db, tap(), NOW);
    const sheets = fakeSheets();
    await syncExpenses({ db, sheets: sheets.client, log });
    assert.deepEqual(statuses(db), ["synced"]);
    assert.equal(sheets.rows.length, 1);
    assert.deepEqual(sheets.rows[0].slice(1), ["Cafe", 12.5, "AUD", "Visa", "jarvis-1", "tap"]);
    await syncExpenses({ db, sheets: sheets.client, log });
    assert.equal(sheets.rows.length, 1, "synced rows are never written again");
  });
  it("does not write duplicates", async () => {
    storeExpense(db, tap(), NOW);
    storeExpense(db, tap(), later(5));
    const sheets = fakeSheets();
    await syncExpenses({ db, sheets: sheets.client, log });
    assert.equal(sheets.rows.length, 1);
  });
  it("leaves a failed expense pending with the error, then retries it", async () => {
    storeExpense(db, tap(), NOW);
    const sheets = fakeSheets();
    sheets.state.failNext = 1;
    await assert.rejects(syncExpenses({ db, sheets: sheets.client, log }), /could not write #1/);
    const row = db.prepare(`SELECT sheet_status, last_error, attempts FROM expenses`).get() as Record<string, unknown>;
    assert.equal(row.sheet_status, "pending");
    assert.match(String(row.last_error), /503/);
    assert.equal(row.attempts, 1);

    await syncExpenses({ db, sheets: sheets.client, log });
    assert.deepEqual(statuses(db), ["synced"]);
    assert.equal(db.prepare(`SELECT last_error FROM expenses`).pluck().get(), null);
    assert.equal(sheets.rows.length, 1);
  });
  it("does not write twice when a write reached Google but the reply was lost", async () => {
    storeExpense(db, tap(), NOW);
    const sheets = fakeSheets();
    sheets.state.failAfterWrite = 1;
    await assert.rejects(syncExpenses({ db, sheets: sheets.client, log }));
    await syncExpenses({ db, sheets: sheets.client, log });
    assert.equal(sheets.rows.length, 1);
    assert.deepEqual(statuses(db), ["synced"]);
    assert.equal(db.prepare(`SELECT sheet_row FROM expenses`).pluck().get(), 2);
  });
  it("checks the Sheet first for a row stuck in 'syncing' (crash mid-write)", async () => {
    storeExpense(db, tap(), NOW);
    const sheets = fakeSheets();
    sheets.rows.push([0, 0, 0, 0, 0, "jarvis-1"]);
    db.prepare(`UPDATE expenses SET sheet_status='syncing', attempts=1`).run();
    await syncExpenses({ db, sheets: sheets.client, log });
    assert.equal(sheets.rows.length, 1);
    assert.deepEqual(statuses(db), ["synced"]);
  });
  it("stops after a fatal error instead of hammering Google, keeping every expense", async () => {
    storeExpense(db, tap("A"), NOW);
    storeExpense(db, tap("B"), later(200));
    const sheets = fakeSheets();
    sheets.state.failNext = 5;
    await assert.rejects(syncExpenses({ db, sheets: sheets.client, log }));
    assert.deepEqual(statuses(db), ["pending", "pending"]);
    assert.equal(db.prepare(`SELECT attempts FROM expenses WHERE id = 2`).pluck().get(), 0, "second one not tried");
  });
  it("waits quietly when Google is not configured", async () => {
    storeExpense(db, tap(), NOW);
    await syncExpenses({ db, sheets: null, log });
    assert.deepEqual(statuses(db), ["pending"]);
    assert.match(logs.join("\n"), /not configured.*1 expense\(s\) waiting/);
  });
  it("re-reads unparsed rows (so a parser fix rescues them)", async () => {
    // Stored as unparsed, then pretend the payload becomes readable.
    storeExpense(db, { raw_data: "nothing here" }, NOW);
    db.prepare(`UPDATE expenses SET raw_payload = ?`).run(JSON.stringify({ raw_data: "Merchant: Bakery\nAmount: 5" }));
    const sheets = fakeSheets();
    await syncExpenses({ db, sheets: sheets.client, log });
    assert.equal(sheets.rows.length, 1);
    assert.equal(sheets.rows[0][1], "Bakery");
  });
});

describe("GoogleSheets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-"));
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const keyFile = path.join(dir, "key.json");
  fs.writeFileSync(keyFile, JSON.stringify({ client_email: "sa@x.iam.gserviceaccount.com", private_key: privateKey }));

  function make(handler: (url: string, init: RequestInit) => unknown, calls: string[] = []) {
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push(String(url));
      const out = handler(String(url), init) as { status?: number; json: unknown };
      return new Response(JSON.stringify(out.json), { status: out.status ?? 200 });
    }) as unknown as typeof fetch;
    let n = 0;
    return {
      sheets: new GoogleSheets({ sheetId: "SID", tab: "My Tab", keyFile, fetchFn, onCall: () => n++ }),
      count: () => n,
    };
  }
  const tokenOk = { json: { access_token: "TOKEN", expires_in: 3600 } };

  it("gets a token, appends with USER_ENTERED, defuses formulas, returns the row, counts calls", async () => {
    const calls: string[] = [];
    let body = "";
    let auth = "";
    const { sheets, count } = make((url, init) => {
      if (url.includes("oauth2")) {
        assert.match(String(init.body), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
        return tokenOk;
      }
      body = String(init.body);
      auth = String((init.headers as Record<string, string>).authorization);
      return { json: { updates: { updatedRange: "'My Tab'!A7:F7" } } };
    }, calls);
    const row = await sheets.appendRow(["2026-11-10 12:00:00", "=HYPERLINK(1)", 1.5, "AUD", "Visa", "jarvis-1"]);
    assert.equal(row, 7);
    assert.equal(auth, "Bearer TOKEN");
    assert.equal(JSON.parse(body).values[0][1], "'=HYPERLINK(1)");
    assert.match(calls.find((u) => u.includes(":append")) ?? "", /My%20Tab.*:append\?valueInputOption=USER_ENTERED/);
    assert.equal(count(), 3, "token + column format lookup + append");
    await sheets.appendRow(["d", "m", 1, "AUD", "c", "jarvis-2"]);
    assert.equal(calls.filter((u) => u.includes("oauth2")).length, 1, "token is cached");
  });
  it("sets column A to date+time once, and still writes if that fails", async () => {
    const calls: { url: string; body: string }[] = [];
    const { sheets } = make((url, init) => {
      calls.push({ url, body: String(init.body ?? "") });
      if (url.includes("oauth2")) return tokenOk;
      if (url.includes("fields=sheets.properties")) return { json: { sheets: [{ properties: { sheetId: 7, title: "My Tab" } }] } };
      return { json: { updates: { updatedRange: "'My Tab'!A9:G9" } } };
    });
    assert.equal(await sheets.appendRow(["d", "m", 1, "AUD", "c", "jarvis-1", "tap"]), 9);
    await sheets.appendRow(["d", "m", 1, "AUD", "c", "jarvis-2", "email"]);
    const batch = calls.filter((c) => c.url.endsWith(":batchUpdate"));
    assert.equal(batch.length, 1, "formatted once");
    const req = JSON.parse(batch[0].body).requests[0].repeatCell;
    assert.equal(req.range.sheetId, 7);
    assert.equal(req.cell.userEnteredFormat.numberFormat.type, "DATE_TIME");
    assert.match(req.cell.userEnteredFormat.numberFormat.pattern, /hh:mm:ss/);

    const failing = make((url) => (url.includes("oauth2") ? tokenOk : url.includes("fields=sheets") ? { status: 403, json: { error: { message: "no" } } } : { json: { updates: { updatedRange: "Sheet1!A2:G2" } } }));
    assert.equal(await failing.sheets.appendRow(["d", "m", 1, "AUD", "c", "x", "tap"]), 2, "a cosmetic failure never blocks the write");
  });
  it("finds a row by marker in column F", async () => {
    const { sheets } = make((url) =>
      url.includes("oauth2") ? tokenOk : { json: { values: [["ID"], [], ["jarvis-1"], ["jarvis-2"]] } },
    );
    assert.equal(await sheets.findRow("jarvis-2"), 4);
    assert.equal(await sheets.findRow("jarvis-9"), null);
  });
  it("turns Google errors into SheetsError without leaking secrets", async () => {
    const { sheets } = make((url) =>
      url.includes("oauth2") ? tokenOk : { status: 403, json: { error: { message: "The caller does not have permission" } } },
    );
    await assert.rejects(sheets.appendRow(["a", "b", 1, "AUD", "c", "d"]), (e: SheetsError) => {
      assert.match(e.message, /403.*permission/);
      assert.ok(!e.message.includes("TOKEN"));
      assert.equal(e.fatal, true);
      return true;
    });
  });
  it("reports a missing key file without printing anything from it", async () => {
    const s = new GoogleSheets({ sheetId: "S", tab: "T", keyFile: path.join(dir, "nope.json"), fetchFn: fetch });
    await assert.rejects(s.findRow("x"), /cannot read GOOGLE_SERVICE_ACCOUNT_FILE/);
  });
});
