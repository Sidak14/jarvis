import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GarageReading } from "./tools/garage";
import { vapiNotes } from "./vapi-api";
import { watchGarage } from "./watch";

const reading = (state: GarageReading["state"]): GarageReading => ({ state, sinceMs: null, opener: true });
const settle = () => new Promise((r) => setTimeout(r, 20));

function run(states: GarageReading["state"][], want: "open" | "closed", limitMs = 40_000) {
  const notes: string[] = [];
  let i = 0;
  watchGarage({ read: async () => reading(states[Math.min(i++, states.length - 1)]), note: async (id, text) => void notes.push(`${id}: ${text}`), sleep: async () => {}, limitMs })("call-9", want);
  return settle().then(() => notes);
}

describe("telling the call how the garage ended", () => {
  it("says the door is closed once it stops moving, without waiting for the whole window", async () => {
    const notes = await run(["closing", "closing", "closed"], "closed");
    assert.equal(notes.length, 1);
    assert.match(notes[0], /^call-9: NOTE: the garage door is now closed\. Mention it briefly at your next natural pause\. Do not interrupt/);
  });

  it("says plainly when the door went back to where it was, and tells the assistant not to retry", async () => {
    const notes = await run(["closing", "open"], "closed");
    assert.match(notes[0], /did not close: it shows open/);
    assert.match(notes[0], /Do not try again unless they ask/);
  });

  it("gives up after the time limit and reports it", async () => {
    const notes = await run(["closing"], "open", 5000);
    assert.match(notes[0], /did not open/);
  });

  it("a failure to reach Vapi is logged, never thrown", async () => {
    const w = watchGarage({ read: async () => reading("closed"), note: async () => { throw new Error("nope"); }, sleep: async () => {} });
    w("call-9", "closed");
    await settle();
  });
});

describe("Vapi call notes", () => {
  it("looks up the call's control URL and posts a system note that does not make the assistant speak", async () => {
    const seen: { url: string; body?: unknown }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return url.includes("/call/") ? new Response(JSON.stringify({ monitor: { controlUrl: "https://control.test/c1" } })) : new Response("{}");
    }) as typeof fetch;
    await vapiNotes({ apiKey: "k".repeat(12), fetchFn })("abc", "NOTE: hi");
    assert.equal(seen[0].url, "https://api.vapi.ai/call/abc");
    assert.equal(seen[1].url, "https://control.test/c1");
    assert.deepEqual(seen[1].body, { type: "add-message", message: { role: "system", content: "NOTE: hi" }, triggerResponseEnabled: false });
  });

  it("refuses a missing or non-https control URL", async () => {
    const none = (async () => new Response(JSON.stringify({}))) as typeof fetch;
    await assert.rejects(vapiNotes({ apiKey: "k".repeat(12), fetchFn: none })("abc", "x"), /no control URL/);
    const http = (async () => new Response(JSON.stringify({ monitor: { controlUrl: "http://evil.test" } }))) as typeof fetch;
    await assert.rejects(vapiNotes({ apiKey: "k".repeat(12), fetchFn: http })("abc", "x"), /no control URL/);
  });
});
