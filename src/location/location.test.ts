import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { createLocationTables } from "./schema";
import { applyLocation, currentLocation, parseLocation } from "./store";
import { openGarageOnArrival } from "./arrive";
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
    assert.equal(currentLocation(db, "me"), null);
    assert.equal(applyLocation(db, "me", { place: "gym", event: "enter" }, T0), "Gym");
    assert.deepEqual(currentLocation(db, "me"), { place: "Gym", since: T0.toISOString() });
    assert.equal(applyLocation(db, "me", { place: "gym", event: "leave" }, T1), "Other");
    assert.equal(currentLocation(db, "me")!.since, T1.toISOString());
    assert.equal((db.prepare(`SELECT COUNT(*) FROM location_events`).pluck().get() as number), 2);
  });

  it("a late 'leave work' does not undo the gym", () => {
    applyLocation(db, "me", { place: "work", event: "enter" }, T0);
    applyLocation(db, "me", { place: "gym", event: "enter" }, T0);
    assert.equal(applyLocation(db, "me", { place: "work", event: "leave" }, T1), "Gym");
  });

  it("each person has their own place, and old data moves over", () => {
    applyLocation(db, "me", { place: "gym", event: "enter" }, T0);
    applyLocation(db, "mom", { place: "home", event: "enter" }, T1);
    assert.equal(currentLocation(db, "me")!.place, "Gym");
    assert.equal(currentLocation(db, "mom")!.place, "Home");
    const old = new Database(":memory:");
    old.exec(`CREATE TABLE location_now (id INTEGER PRIMARY KEY CHECK (id = 1), place TEXT NOT NULL, since TEXT NOT NULL);
      INSERT INTO location_now VALUES (1, 'Work', '2026-11-01T00:00:00Z');
      CREATE TABLE location_events (id INTEGER PRIMARY KEY AUTOINCREMENT, place TEXT NOT NULL, event TEXT NOT NULL, received_at TEXT NOT NULL);
      INSERT INTO location_events (place, event, received_at) VALUES ('work', 'enter', '2026-11-01T00:00:00Z');`);
    createLocationTables(old);
    assert.equal(currentLocation(old, "me")!.place, "Work");
    assert.equal(old.prepare(`SELECT person FROM location_events`).pluck().get(), "me");
  });

  it("the webhook answers 202 and stores, or 400 for a body it cannot use", async () => {
    const hook = createLocationWebhook({ db, person: "me", now: () => T0 });
    const ok = await hook({ body: { kind: "location", place: "home", event: "enter" }, rawText: "", log: () => {} });
    assert.equal(ok.status, 202);
    assert.equal(currentLocation(db, "me")!.place, "Home");
    const bad = await hook({ body: undefined, rawText: "hello", log: () => {} });
    assert.equal(bad.status, 400);
    assert.equal(currentLocation(db, "me")!.place, "Home");
  });
});

describe("arriving home opens the garage", () => {
  const ha = (state: string, opener = true) => {
    const pressed: string[] = [];
    return { pressed, client: { garage: async () => ({ state, opener }), pressGarage: async (a: string) => void pressed.push(a) } as never };
  };
  it("presses Open only when the door is closed and the opener is reachable", async () => {
    const cases: [string, boolean, string, string[]][] = [
      ["closed", true, "opened", ["open"]],
      ["open", true, "already open", []],
      ["opening", true, "moving", []],
      ["closed", false, "unreadable", []],
      ["unavailable", true, "unreadable", []],
    ];
    for (const [state, opener, result, pressed] of cases) {
      const h = ha(state, opener);
      assert.equal(await openGarageOnArrival(h.client), result);
      assert.deepEqual(h.pressed, pressed);
    }
  });
  it("only 'enter home' triggers it", async () => {
    let n = 0;
    const db = new Database(":memory:");
    createLocationTables(db);
    const hook = createLocationWebhook({ db, person: "me", now: () => T0, onArriveHome: () => void n++ });
    for (const [place, event] of [["gym", "enter"], ["home", "leave"], ["home", "enter"]]) await hook({ body: { kind: "location", place, event }, rawText: "", log: () => {} });
    assert.equal(n, 1);
  });
});
