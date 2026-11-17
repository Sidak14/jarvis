import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { createLocationTables } from "./schema";
import { applyLocation, currentLocation, parseLocation } from "./store";
import { createLocationWebhook } from "./webhook";

const T0 = new Date("2026-11-17T01:00:00Z");
const T1 = new Date("2026-11-17T02:00:00Z");

describe("location", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    createLocationTables(db);
  });

  it("reads the Shortcut's dictionary, in any capitals, and refuses anything else", () => {
    assert.deepEqual(parseLocation({ kind: "location", place: "Home", event: "ENTER" }), { place: "home", event: "enter" });
    assert.equal(parseLocation({ kind: "location", place: "school", event: "enter" }), null);
    assert.equal(parseLocation({ kind: "location", place: "home", event: "arrive" }), null);
    assert.equal(parseLocation({ kind: "expense", place: "home", event: "enter" }), null);
    assert.equal(parseLocation("home"), null);
    assert.equal(parseLocation(null), null);
  });

  it("enter sets the place, leave goes to Other, and nothing is known at first", () => {
    assert.equal(currentLocation(db), null);
    assert.equal(applyLocation(db, { place: "gym", event: "enter" }, T0), "Gym");
    assert.deepEqual(currentLocation(db), { place: "Gym", since: T0.toISOString() });
    assert.equal(applyLocation(db, { place: "gym", event: "leave" }, T1), "Other");
    assert.equal(currentLocation(db)!.since, T1.toISOString());
    assert.equal((db.prepare(`SELECT COUNT(*) FROM location_events`).pluck().get() as number), 2);
  });

  it("a late 'leave work' does not undo the gym", () => {
    applyLocation(db, { place: "work", event: "enter" }, T0);
    applyLocation(db, { place: "gym", event: "enter" }, T0);
    assert.equal(applyLocation(db, { place: "work", event: "leave" }, T1), "Gym");
  });

  it("the webhook answers 202 and stores, or 400 for a body it cannot use", async () => {
    const hook = createLocationWebhook({ db, now: () => T0 });
    const ok = await hook({ body: { kind: "location", place: "home", event: "enter" }, rawText: "", log: () => {} });
    assert.equal(ok.status, 202);
    assert.equal(currentLocation(db)!.place, "Home");
    const bad = await hook({ body: undefined, rawText: "hello", log: () => {} });
    assert.equal(bad.status, 400);
    assert.equal(currentLocation(db)!.place, "Home");
  });
});
