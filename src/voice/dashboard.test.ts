import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { voicePage } from "../ui/pages/voice";
import type { VoiceFlags } from "../ui/vm/types";
import { buildVoice, resultWords, voiceModule } from "../ui/vm/voice";
import { openEpisode } from "./alerts";
import { finishCall, logToolCall, registerCall } from "./calls";
import { createVoiceTables } from "./schema";

const NOW = new Date("2026-11-17T04:00:00Z");
const FLAGS: VoiceFlags = { enabled: true, configured: true, writesLive: false, pinSet: true, capUsd: 10 };

describe("the Calls page and the Voice card", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    createVoiceTables(db);
  });
  const call = (id: string, at: string, o: { dir?: "inbound" | "outbound"; reason?: string; cost?: number; seconds?: number; tools?: [string, "ok" | "error"][]; episode?: number } = {}) => {
    registerCall(db, { id, direction: o.dir ?? "inbound", number: "+61405642326", alertEpisodeId: o.episode }, new Date(at));
    for (const [tool, status] of o.tools ?? []) logToolCall(db, id, tool, status, 5, {}, new Date(at));
    finishCall(db, id, { endedReason: o.reason ?? "customer-ended-call", cost: o.cost ?? 0.02, startedAt: at, endedAt: new Date(Date.parse(at) + (o.seconds ?? 30) * 1000).toISOString() }, new Date(at));
  };

  it("counts this month's calls, spend and tools, and names how each call went", () => {
    call("a", "2026-11-05T01:00:00Z", { tools: [["ping", "ok"]], cost: 0.1 });
    call("b", "2026-11-10T01:00:00Z", { dir: "outbound", reason: "voicemail", cost: 0.05, episode: 1 });
    call("c", "2026-11-12T01:00:00Z", { dir: "outbound", reason: "customer-did-not-answer", cost: 0, seconds: 0 });
    call("old", "2026-10-20T01:00:00Z", { cost: 5, tools: [["ping", "ok"]] });
    const vm = buildVoice(db, NOW, FLAGS);
    assert.equal(vm.callsThisMonth, 3);
    assert.deepEqual([vm.inboundThisMonth, vm.outboundThisMonth], [1, 2]);
    assert.ok(Math.abs(vm.spentUsd - 0.15) < 1e-9, "October's call is not counted");
    assert.equal(vm.level, "ok");
    assert.deepEqual(vm.tools, [{ tool: "ping", calls: 1, failures: 0 }]);
    assert.deepEqual(vm.calls.map((c) => [c.id, c.result]), [["c", "not answered"], ["b", "voicemail"], ["a", "answered"], ["old", "answered"]]);
    assert.equal(vm.lastCall?.id, "c");
    assert.equal(vm.calls.find((c) => c.id === "b")?.alert, true);
    assert.deepEqual(vm.calls.find((c) => c.id === "a")?.tools, ["ping"]);
  });

  it("hides calls that are still waiting to get a Vapi id, and shows one in progress as in progress", () => {
    registerCall(db, { id: "pending-1-123", direction: "outbound", number: "+61405642326" }, NOW);
    registerCall(db, { id: "live", direction: "inbound", number: "+61405642326" }, NOW);
    const vm = buildVoice(db, NOW, FLAGS);
    assert.deepEqual(vm.calls.map((c) => [c.id, c.result]), [["live", "in progress"]]);
    assert.equal(vm.callsThisMonth, 1);
    assert.equal(resultWords(null, null, null), "in progress");
  });

  it("the card is amber at 80% of the limit, red at 100%, and amber if a tool failed", () => {
    call("a", "2026-11-05T01:00:00Z", { cost: 8.5 });
    assert.equal(voiceModule(buildVoice(db, NOW, FLAGS), []).state, "warn");
    call("b", "2026-11-06T01:00:00Z", { cost: 2 });
    const red = voiceModule(buildVoice(db, NOW, FLAGS), []);
    assert.equal(red.state, "error");
    assert.match(red.issues[0], /monthly voice limit is reached/);
    const calm = new Database(":memory:");
    createVoiceTables(calm);
    assert.equal(voiceModule(buildVoice(calm, NOW, FLAGS), []).state, "ok");
    registerCall(calm, { id: "x", direction: "inbound", number: "+61405642326" }, NOW);
    logToolCall(calm, "x", "close_garage", "error", 5, {}, NOW);
    const failed = voiceModule(buildVoice(calm, NOW, FLAGS), []);
    assert.equal(failed.state, "warn");
    assert.match(failed.issues.join(" "), /1 voice tool call failed/);
  });

  it("the card says what mode Home Assistant writes are in, is off when voice is off or not set up, and warns about a missing PIN", () => {
    assert.equal(voiceModule(buildVoice(db, NOW, FLAGS), []).mode, "dry");
    assert.equal(voiceModule(buildVoice(db, NOW, { ...FLAGS, writesLive: true }), []).mode, "live");
    assert.equal(voiceModule(buildVoice(db, NOW, { ...FLAGS, enabled: false }), []).state, "off");
    const unset = voiceModule(buildVoice(db, NOW, { ...FLAGS, configured: false }), []);
    assert.equal(unset.state, "off");
    assert.match(unset.summary, /Not set up/);
    assert.match(voiceModule(buildVoice(db, NOW, { ...FLAGS, pinSet: false }), []).issues.join(" "), /No PIN is set/);
  });

  it("shows an open alert on the card", () => {
    openEpisode(db, "garage_open", NOW);
    const card = voiceModule(buildVoice(db, NOW, FLAGS), []);
    assert.match(card.issues.join(" "), /Alert open: garage open/);
  });

  it("the page renders the table and the figures, escapes the summary, and never mentions a transcript as something kept", () => {
    call("a", "2026-11-05T01:00:00Z", { tools: [["ping", "ok"]], cost: 0.0191 });
    db.prepare(`UPDATE voice_calls SET summary = ? WHERE call_id = 'a'`).run("<script>alert(1)</script> You called Jarvis");
    const html = voicePage(buildVoice(db, NOW, FLAGS), NOW);
    assert.match(html, /Spend this month/);
    assert.match(html, /\$0\.019/);
    assert.match(html, /You called Jarvis/);
    assert.ok(!html.includes("<script>alert(1)"), "summary text is escaped");
    assert.match(html, /No transcript, no recording/);
    assert.match(html, /href="\/calls"/, "the nav has a Calls link");
  });

  it("the empty page is friendly, and the banner explains when voice is off or not set up", () => {
    assert.match(voicePage(buildVoice(db, NOW, FLAGS), NOW), /No calls yet/);
    assert.match(voicePage(buildVoice(db, NOW, { ...FLAGS, enabled: false }), NOW), /Voice is switched off/);
    assert.match(voicePage(buildVoice(db, NOW, { ...FLAGS, configured: false }), NOW), /Voice is not set up/);
  });
});
