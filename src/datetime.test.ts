import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { storeExpense } from "./expenses/store";
import { createExpenseTables } from "./expenses/schema";
import Database from "better-sqlite3";
import { hasTimeOfDay, resolveTimestamp } from "./datetime";

const ANCHOR = "2026-11-10T02:27:00.000Z";

describe("resolveTimestamp", () => {
  it("keeps a timestamp that has a time", () => {
    assert.equal(resolveTimestamp("2026-11-09T10:30:00Z", ANCHOR), "2026-11-09T10:30:00.000Z");
    assert.ok(hasTimeOfDay("12:27"));
    assert.ok(!hasTimeOfDay("2026-11-09"));
  });
  it("a bare date for the same day takes the time we received the message", () => {
    assert.equal(resolveTimestamp("2026-11-10", ANCHOR), ANCHOR);
    assert.equal(resolveTimestamp("2026-11-09", ANCHOR), ANCHOR); // within a day (time zones)
  });
  it("a bare date from another day is kept, at midday local time", () => {
    const iso = resolveTimestamp("2026-10-01", ANCHOR);
    assert.ok(iso);
    const d = new Date(iso!);
    assert.equal(d.getHours(), 12);
    assert.equal(d.getMinutes(), 0);
    assert.equal(d.toLocaleDateString("sv-SE"), "2026-10-01");
  });
  it("returns null for nonsense", () => {
    assert.equal(resolveTimestamp("later", ANCHOR), null);
    assert.equal(resolveTimestamp(null, ANCHOR), null);
  });
});

describe("a tap is stored with a full datetime", () => {
  const db = new Database(":memory:");
  createExpenseTables(db);
  const occurred = (raw: object, now: Date) => {
    const r = storeExpense(db, { raw_data: raw }, now);
    return db.prepare(`SELECT occurred_at FROM expenses WHERE id = ?`).pluck().get(r.id);
  };
  it("uses the moment of the tap when no date is given", () => {
    assert.equal(occurred({ Merchant: "A", Amount: "$1.00" }, new Date(ANCHOR)), ANCHOR);
  });
  it("uses the moment of the tap when the date is date-only", () => {
    assert.equal(occurred({ Merchant: "B", Amount: "$2.00", Date: "2026-11-10" }, new Date(ANCHOR)), ANCHOR);
  });
  it("keeps a datetime that Wallet provides", () => {
    assert.equal(occurred({ Merchant: "C", Amount: "$3.00", Date: "2026-11-10T01:05:09Z" }, new Date(ANCHOR)), "2026-11-10T01:05:09.000Z");
  });
});
