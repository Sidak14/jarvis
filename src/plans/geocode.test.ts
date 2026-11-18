import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { plansPage } from "../ui/pages/plans";
import type { PlansVM } from "../ui/vm/plans";
import { buildAiUsage } from "../ui/vm/ai";
import { lookupAddress } from "./geocode";
import { deletePlace, editPlace, ensurePlace, findPlace, listPlaces, mapsUrl, resolveLocation, saveAddress, verifyPlace } from "./places";
import { createAllTables } from "../schema";
import { createPlansTables } from "./schema";

const NOW = new Date("2026-11-18T10:00:00Z");
const found = (address: string, id = "ChIJabc") => (async () => new Response(JSON.stringify({ status: "OK", results: [{ formatted_address: address, place_id: id }] }))) as typeof fetch;
const status = (s: string, extra: object = {}) => (async () => new Response(JSON.stringify({ status: s, ...extra }))) as typeof fetch;

describe("looking an address up on Google", () => {
  it("says it is not configured, rather than guessing, when there is no key", async () => {
    const r = await lookupAddress("16 Horsfield Street", { apiKey: undefined });
    assert.deepEqual([r.ok, !r.ok && r.reason], [false, "not_configured"]);
    assert.match(!r.ok ? r.message : "", /isn't configured/);
  });

  it("returns Google's full address and place id, sending only the typed text and the key", async () => {
    let url = "";
    const r = await lookupAddress("16 Horsfield Street", { apiKey: "K".repeat(12), fetchFn: (async (u: string) => ((url = u), new Response(JSON.stringify({ status: "OK", results: [{ formatted_address: "16 Horsfield St, Bungarribee NSW 2767, Australia", place_id: "P1" }] })))) as typeof fetch });
    assert.deepEqual(r, { ok: true, address: "16 Horsfield St, Bungarribee NSW 2767, Australia", placeId: "P1" });
    assert.match(url, /address=16%20Horsfield%20Street/);
    assert.match(url, /components=country:AU/);
  });

  it("not found, refused keys, server errors and network failures each come back as a plain reason", async () => {
    const miss = await lookupAddress("zzz", { apiKey: "K".repeat(12), fetchFn: status("ZERO_RESULTS") });
    assert.deepEqual([miss.ok, !miss.ok && miss.reason], [false, "not_found"]);
    const denied = await lookupAddress("a", { apiKey: "K".repeat(12), fetchFn: status("REQUEST_DENIED", { error_message: "API key invalid" }) });
    assert.match(!denied.ok ? denied.message : "", /REQUEST_DENIED: API key invalid/);
    const http = await lookupAddress("a", { apiKey: "K".repeat(12), fetchFn: (async () => new Response("no", { status: 500 })) as typeof fetch });
    assert.match(!http.ok ? http.message : "", /answered 500/);
    const down = await lookupAddress("a", { apiKey: "K".repeat(12), fetchFn: (async () => { throw new Error("offline"); }) as typeof fetch });
    assert.match(!down.ok ? down.message : "", /Couldn't reach Google Maps: offline/);
  });
});

describe("saved places", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    createPlansTables(db);
  });
  const place = (name: string, typed?: string) => {
    const p = ensurePlace(db, name, NOW);
    if (typed) saveAddress(db, p.id, typed);
    return p.id;
  };

  it("what Google found replaces the typed address everywhere, and the typed text is kept for reference", async () => {
    const id = place("Horsfield", "16 Horsfield Street");
    assert.equal(findPlace(db, "Horsfield")!.verified, 0);
    const r = await verifyPlace(db, id, "K".repeat(12), found("16 Horsfield St, Bungarribee NSW 2767, Australia", "PX"));
    assert.equal(r.ok, true);
    const p = findPlace(db, "Horsfield")!;
    assert.deepEqual([p.address, p.typed_address, p.verified, p.place_id], ["16 Horsfield St, Bungarribee NSW 2767, Australia", "16 Horsfield Street", 1, "PX"]);
    assert.equal(resolveLocation(db, "Horsfield"), "16 Horsfield St, Bungarribee NSW 2767, Australia", "the calendar event gets Google's address");
    assert.match(mapsUrl(db, "Horsfield")!, /query_place_id=PX/);
  });

  it("when Google can't be asked or doesn't know it, the typed address stays, unverified, with the reason", async () => {
    const id = place("Rijul's house", "7 John Campbell parade, bungarribee");
    const none = await verifyPlace(db, id, undefined);
    assert.equal(none.ok, false);
    assert.equal(findPlace(db, "Rijul's house")!.verified, 0);
    assert.equal(resolveLocation(db, "Rijul's house"), "7 John Campbell parade, bungarribee, NSW, Australia", "falls back to the typed address with its state");
    const miss = await verifyPlace(db, id, "K".repeat(12), status("ZERO_RESULTS"));
    assert.equal(!miss.ok && miss.reason, "not_found");
    assert.equal(findPlace(db, "Rijul's house")!.address, "7 John Campbell parade, bungarribee");
  });

  it("editing renames the place, moves plans that used the old name, and keeps names unique", () => {
    const id = place("Sajid's house", "5 oakvale Avenue");
    place("Rijul's house");
    db.exec(`CREATE TABLE IF NOT EXISTS plans_tmp (x INTEGER)`);
    assert.match(editPlace(db, id, "Rijul's house", "")!, /already a place called/);
    assert.match(editPlace(db, id, "  ", "")!, /can't be empty/);
    assert.equal(editPlace(db, id, "Sajid's place", "6 New Street"), null);
    const p = findPlace(db, "Sajid's place")!;
    assert.deepEqual([p.address, p.typed_address, p.verified], ["6 New Street", "6 New Street", 0]);
    assert.equal(findPlace(db, "Sajid's house"), undefined);
  });

  it("saving the form without touching the address keeps Google's verified address", async () => {
    const id = place("Horsfield", "16 Horsfield Street");
    await verifyPlace(db, id, "K".repeat(12), found("16 Horsfield St, Bungarribee NSW 2767, Australia"));
    // the form shows what I typed originally, so submitting it again is not a change
    assert.equal(editPlace(db, id, "Horsfield", "16 Horsfield Street"), null);
    assert.equal(findPlace(db, "Horsfield")!.verified, 1);
    assert.equal(editPlace(db, id, "Horsfield", "20 Other Road"), null);
    assert.equal(findPlace(db, "Horsfield")!.verified, 0, "a new address needs a new lookup");
  });

  it("deleting removes the place", () => {
    const id = place("Old place", "1 Old Rd");
    assert.equal(deletePlace(db, id), true);
    assert.equal(deletePlace(db, id), false);
    assert.equal(listPlaces(db).length, 0);
  });

  it("the Plans page shows Google's address with a status, edit and delete, and warns when Maps is not configured", () => {
    const full = new Database(":memory:");
    createAllTables(full);
    const status0 = { beeper: { configured: false, connected: false, error: null, accounts: null, lastPollAt: null, baseUrl: "" }, scope: "", dryRun: false, calendarConnected: false, lastBatchSummary: null, lastBatchAt: null, foundThisWeek: 0, messagesWaiting: 0, runError: null, ai: buildAiUsage(full, NOW) };
    const vm = (over: Partial<PlansVM>): PlansVM => ({ status: status0, needs: [], clashes: [], upcoming: [], proposed: [], past: [], would: [], places: [], mapsConfigured: false, showWould: false, ...over });
    const places = [
      { id: 1, name: "Horsfield", address: "16 Horsfield St, Bungarribee NSW 2767, Australia", typed: "16 Horsfield Street", verified: true, mapUrl: "https://www.google.com/maps/search/?api=1&query=x" },
      { id: 2, name: "Rijul's house", address: "7 John Campbell parade", typed: "7 John Campbell parade", verified: false, mapUrl: "https://www.google.com/maps/search/?api=1&query=y" },
    ];
    const html = plansPage(vm({ places }), NOW);
    assert.match(html, /16 Horsfield St, Bungarribee NSW 2767, Australia/);
    assert.match(html, /you wrote: 16 Horsfield Street/);
    assert.match(html, /On Google Maps/);
    assert.match(html, /Not verified/);
    assert.match(html, /Google Maps isn&#39;t configured yet|Google Maps isn't configured yet/);
    assert.match(html, /action="\/plans\/places\/1\/delete"/);
    assert.match(html, /action="\/plans\/places\/2\/save"/);
    const configured = plansPage(vm({ places, mapsConfigured: true }), NOW, { ok: "Deleted X." });
    assert.ok(!/isn.t configured yet/.test(configured));
    assert.match(configured, /Look up 1 unverified address on Google/);
    assert.match(configured, /Deleted X\./);
  });
});
