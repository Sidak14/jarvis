import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { ALERT_KINDS, classifyEnd, decide, handleCallEnded, MAX_PER_DAY, MIN_GAP_MS, openEpisode, openEpisodes, resolveEpisodes, runAlerts, type AlertDeps, type Episode } from "./alerts";
import { getCall, registerCall, finishCall } from "./calls";
import { createHaWebhook } from "./ha-webhook";
import { createVoiceTables } from "./schema";
import type { GarageReading } from "./tools/garage";
import { vapiCalls } from "./vapi-api";

const MIN = 60_000;
const HOUR = 60 * MIN;
// Tue 17 Nov 2026: 3:00pm Sydney (UTC+11)
const DAY = new Date("2026-11-17T04:00:00Z");

const episode = (over: Partial<Episode> = {}): Episode => ({ id: 1, kind: "garage_open", started_at: DAY.toISOString(), last_attempt_at: null, attempts_today: 0, attempts_day: null, resolved_at: null, detail: null, ...over });
const at = (iso: string) => new Date(iso);

describe("alert rules", () => {
  const go = (ep: Episode, now: Date, o: { stillActive?: boolean; budgetCapped?: boolean } = {}) => decide(ep, now, { stillActive: o.stillActive ?? true, budgetCapped: o.budgetCapped ?? false });

  it("calls the first time", () => {
    assert.deepEqual(go(episode(), DAY), { action: "call" });
  });

  it("waits 30 minutes between calls", () => {
    const ep = episode({ last_attempt_at: DAY.toISOString(), attempts_today: 1, attempts_day: "2026-11-17" });
    assert.equal(go(ep, new Date(DAY.getTime() + 29 * MIN)).action, "wait");
    assert.equal(go(ep, new Date(DAY.getTime() + MIN_GAP_MS)).action, "call");
  });

  it("makes at most 3 calls a day, and the count starts again on a new Sydney day", () => {
    const ep = episode({ last_attempt_at: DAY.toISOString(), attempts_today: MAX_PER_DAY, attempts_day: "2026-11-17" });
    assert.deepEqual(go(ep, new Date(DAY.getTime() + 5 * HOUR)), { action: "wait", reason: "daily limit" });
    assert.equal(go(ep, new Date("2026-11-17T12:30:00Z")).action, "wait", "11:30pm on the 17th in Sydney: still the same day");
    assert.equal(go(ep, new Date("2026-11-17T13:30:00Z")).action, "call", "12:30am on the 18th: a new day (the garage may call at night)");
  });

  it("stops when it is resolved or the thing is no longer the case", () => {
    assert.equal(go(episode({ resolved_at: DAY.toISOString() }), DAY).action, "stop");
    assert.equal(go(episode(), DAY, { stillActive: false }).action, "stop");
    assert.equal(go(episode({ kind: "unknown" }), DAY).action, "stop");
  });

  it("the garage alert is urgent: it may call at 3am", () => {
    assert.equal(go(episode(), new Date("2026-11-16T16:00:00Z")).action, "call");
  });

  it("a non-urgent kind keeps quiet from 11pm to 7am Sydney", () => {
    ALERT_KINDS.test_calm = { urgent: false };
    try {
      const calm = episode({ kind: "test_calm" });
      assert.equal(go(calm, new Date("2026-11-17T12:00:00Z")).action, "wait", "11pm Sydney");
      assert.equal(go(calm, new Date("2026-11-16T19:30:00Z")).action, "wait", "6:30am Sydney");
      assert.equal(go(calm, new Date("2026-11-16T20:00:00Z")).action, "call", "7am Sydney");
      assert.equal(go(calm, new Date("2026-11-17T11:59:00Z")).action, "call", "10:59pm Sydney");
    } finally {
      delete ALERT_KINDS.test_calm;
    }
  });

  it("at the monthly limit it does not call, it only tells me", () => {
    assert.deepEqual(go(episode(), DAY, { budgetCapped: true }), { action: "telegram_only", reason: "the monthly voice limit is reached" });
  });
});

describe("how a call ended", () => {
  it("separates answered, voicemail and nobody", () => {
    assert.equal(classifyEnd("customer-ended-call", 40), "answered");
    assert.equal(classifyEnd("assistant-ended-call", 20), "answered");
    assert.equal(classifyEnd("voicemail", 12), "voicemail");
    assert.equal(classifyEnd("customer-did-not-answer", 0), "unanswered");
    assert.equal(classifyEnd("customer-busy", 0), "unanswered");
    assert.equal(classifyEnd("twilio-failed-to-connect-call", 0), "unanswered");
    assert.equal(classifyEnd("silence-timed-out", 35), "unanswered");
    assert.equal(classifyEnd(null, 0), "unanswered");
    assert.equal(classifyEnd(null, 30), "answered");
  });
});

describe("the alert run", () => {
  let db: Database.Database;
  let clock: number;
  let garage: GarageReading | Error;
  let placed: string[];
  let failNext: boolean;
  let sent: string[];
  let cap: number;
  const deps = (): AlertDeps => ({
    db,
    now: () => new Date(clock),
    enabled: true,
    ownerPhone: "+61405642326",
    capUsd: cap,
    garage: async () => {
      if (garage instanceof Error) throw garage;
      return garage;
    },
    placeCall: async ({ alert }) => {
      // The call is recorded BEFORE it is placed.
      const pending = db.prepare(`SELECT call_id, alert_episode_id FROM voice_calls WHERE direction = 'outbound' AND call_id LIKE 'pending-%'`).all();
      assert.equal(pending.length, 1, "registered first");
      if (failNext) {
        failNext = false;
        throw new Error("Vapi answered 500");
      }
      placed.push(alert);
      return `vapi-call-${placed.length}`;
    },
    notify: (text) => void sent.push(text),
  });
  const open = (minutes: number): GarageReading => ({ state: "open", sinceMs: minutes * MIN, opener: true });

  beforeEach(() => {
    db = new Database(":memory:");
    createVoiceTables(db);
    clock = DAY.getTime();
    garage = open(12);
    placed = [];
    sent = [];
    failNext = false;
    cap = 10;
  });

  it("phones once when the garage has been open 10 minutes, with what to say, and records the call under Vapi's id", async () => {
    assert.deepEqual(await runAlerts(deps()), ["garage_open: phoned"]);
    assert.deepEqual(placed, ["the garage has been open for twelve minutes"]);
    const call = getCall(db, "vapi-call-1")!;
    assert.equal(call.direction, "outbound");
    assert.equal(call.alert_episode_id, openEpisodes(db)[0].id);
    assert.equal(db.prepare(`SELECT COUNT(*) FROM voice_calls WHERE call_id LIKE 'pending-%'`).pluck().get(), 0);
    assert.equal(sent.length, 0, "no Telegram while the call is going");
  });

  it("does nothing while the garage has been open less than 10 minutes, or closed, or cannot be read", async () => {
    garage = open(9);
    assert.deepEqual(await runAlerts(deps()), []);
    garage = { state: "closed", sinceMs: 5 * MIN, opener: true };
    assert.deepEqual(await runAlerts(deps()), []);
    garage = { state: "unavailable", sinceMs: null, opener: false };
    assert.deepEqual(await runAlerts(deps()), []);
    garage = new Error("Home Assistant is down");
    assert.deepEqual(await runAlerts(deps()), []);
    assert.equal(placed.length + openEpisodes(db).length, 0);
  });

  it("the webhook and the watchdog finding the same thing is one episode and one call", async () => {
    await runAlerts(deps());
    await runAlerts(deps());
    await runAlerts(deps());
    assert.equal(placed.length, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) FROM alert_episodes`).pluck().get(), 1);
  });

  it("retries every 30 minutes, at most 3 a day, then stops until tomorrow", async () => {
    await runAlerts(deps());
    for (const step of [31, 31, 31, 31]) {
      clock += step * MIN;
      garage = open(12 + (clock - DAY.getTime()) / MIN);
      await runAlerts(deps());
    }
    assert.equal(placed.length, 3);
    clock += 12 * HOUR; // the next Sydney morning
    garage = open(900);
    await runAlerts(deps());
    assert.equal(placed.length, 4, "a new day, a new allowance");
  });

  it("stops the moment the garage closes, even in the middle of the retries", async () => {
    await runAlerts(deps());
    clock += 40 * MIN;
    garage = { state: "closed", sinceMs: 2 * MIN, opener: true };
    assert.deepEqual(await runAlerts(deps()), ["garage_open: resolved"]);
    clock += 40 * MIN;
    assert.deepEqual(await runAlerts(deps()), []);
    assert.equal(placed.length, 1);
    assert.equal(openEpisodes(db).length, 0);
    // and if it is left open again later, that is a new episode
    garage = open(11);
    clock += HOUR;
    await runAlerts(deps());
    assert.equal(placed.length, 2);
    assert.equal(db.prepare(`SELECT COUNT(*) FROM alert_episodes`).pluck().get(), 2);
  });

  it("a call that cannot be placed becomes a Telegram message, and still counts as an attempt", async () => {
    failNext = true;
    assert.deepEqual(await runAlerts(deps()), ["garage_open: call failed, telegram sent"]);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /garage has been open for twelve minutes.*didn't go through/);
    assert.equal(db.prepare(`SELECT COUNT(*) FROM voice_calls`).pluck().get(), 0);
    await runAlerts(deps());
    assert.equal(placed.length, 0, "the 30 minute gap applies after a failure too");
  });

  it("at the monthly limit it sends Telegram instead of calling", async () => {
    registerCall(db, { id: "big", direction: "inbound", number: "+61400000000" }, DAY);
    db.prepare(`UPDATE voice_calls SET cost_usd = 11 WHERE call_id = 'big'`).run();
    assert.deepEqual(await runAlerts(deps()), ["garage_open: telegram only"]);
    assert.equal(placed.length, 0);
    assert.match(sent[0], /didn't phone because the monthly voice limit is reached/);
  });

  it("does nothing at all when voice is switched off", async () => {
    assert.deepEqual(await runAlerts({ ...deps(), enabled: false }), []);
    assert.equal(openEpisodes(db).length, 0);
  });

  it("episodes: the same kind is one episode until it is resolved", () => {
    const a = openEpisode(db, "garage_open", DAY);
    assert.equal(openEpisode(db, "garage_open", DAY).id, a.id);
    assert.equal(resolveEpisodes(db, "garage_open", DAY), 1);
    assert.notEqual(openEpisode(db, "garage_open", DAY).id, a.id);
  });
});

describe("after an alert call ends", () => {
  let db: Database.Database;
  let sent: string[];
  const NOW = new Date("2026-11-17T04:30:00Z");
  const end = (reason: string, seconds: number, epDetail: object = { open_since: "2026-11-17T04:00:00Z" }) => {
    const ep = openEpisode(db, "garage_open", DAY, epDetail);
    registerCall(db, { id: "c1", direction: "outbound", number: "+61405642326", alertEpisodeId: ep.id }, DAY);
    const row = finishCall(db, "c1", { endedReason: reason, cost: 0.1, startedAt: DAY.toISOString(), endedAt: new Date(DAY.getTime() + seconds * 1000).toISOString() }, NOW)!;
    handleCallEnded({ db, now: () => NOW, notify: (t) => void sent.push(t) }, row);
  };
  beforeEach(() => {
    db = new Database(":memory:");
    createVoiceTables(db);
    sent = [];
  });

  it("voicemail, not answered, busy and failed calls each send Telegram saying so, without hiding that it is still open", () => {
    end("voicemail", 15);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /still open\. I phoned you but it went to voicemail/);
    assert.match(sent[0], /thirty minutes/);
  });
  it("did-not-answer says you didn't pick up", () => {
    end("customer-did-not-answer", 0);
    assert.match(sent[0], /you didn't pick up/);
  });
  it("an answered call sends no extra Telegram (the call summary does that)", () => {
    end("customer-ended-call", 45);
    assert.deepEqual(sent, []);
  });
  it("an alert that was fixed meanwhile says nothing, and a normal inbound call is ignored", () => {
    const ep = openEpisode(db, "garage_open", DAY);
    resolveEpisodes(db, "garage_open", DAY);
    registerCall(db, { id: "c2", direction: "outbound", number: "+61405642326", alertEpisodeId: ep.id }, DAY);
    handleCallEnded({ db, now: () => NOW, notify: (t) => void sent.push(t) }, finishCall(db, "c2", { endedReason: "voicemail", cost: 0, startedAt: null, endedAt: null }, NOW)!);
    registerCall(db, { id: "c3", direction: "inbound", number: "+61405642326" }, DAY);
    handleCallEnded({ db, now: () => NOW, notify: (t) => void sent.push(t) }, finishCall(db, "c3", { endedReason: "voicemail", cost: 0, startedAt: null, endedAt: null }, NOW)!);
    assert.deepEqual(sent, []);
  });
});

describe("the Home Assistant webhook", () => {
  const SECRET = "w".repeat(40);
  it("needs the secret, answers at once, and starts a check", async () => {
    let checks = 0;
    const app = createHaWebhook({ secret: SECRET, onGarageOpen: async () => void checks++ });
    const post = (auth?: string) => app.request("/garage-open", { method: "POST", headers: auth ? { authorization: auth } : {}, body: "{}" });
    assert.equal((await post()).status, 401);
    assert.equal((await post("Bearer nope")).status, 401);
    assert.equal(checks, 0);
    assert.equal((await post(`Bearer ${SECRET}`)).status, 202);
    assert.equal(checks, 1);
  });
  it("a failing check does not turn the answer into an error", async () => {
    const app = createHaWebhook({ secret: SECRET, onGarageOpen: async () => { throw new Error("boom"); } });
    assert.equal((await app.request("/garage-open", { method: "POST", headers: { authorization: `Bearer ${SECRET}` } })).status, 202);
  });
});

describe("placing the call with Vapi", () => {
  it("rings my number with the assistant, stays silent until I speak, and passes the alert as a variable", async () => {
    let sent: { url: string; auth: string | null; body: Record<string, unknown> } | null = null;
    const placer = vapiCalls({
      apiKey: "KEY",
      phoneNumberId: "pn-1",
      assistantId: () => "asst-1",
      fetchFn: (async (url: string, init: RequestInit) => {
        sent = { url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) };
        return new Response(JSON.stringify({ id: "call-42" }), { status: 201 });
      }) as unknown as typeof fetch,
    });
    assert.equal(await placer.placeAlertCall({ number: "+61405642326", alert: "the garage has been open for twelve minutes" }), "call-42");
    assert.equal(sent!.url, "https://api.vapi.ai/call");
    assert.equal(sent!.auth, "Bearer KEY");
    assert.deepEqual(sent!.body, {
      assistantId: "asst-1",
      phoneNumberId: "pn-1",
      customer: { number: "+61405642326" },
      assistantOverrides: { firstMessageMode: "assistant-waits-for-user", firstMessage: "", variableValues: { alert: "the garage has been open for twelve minutes" }, maxDurationSeconds: 180 },
    });
  });

  it("fails clearly when Vapi refuses, or the assistant has not been pushed", async () => {
    const refuse = vapiCalls({ apiKey: "K", phoneNumberId: "p", assistantId: () => "a", fetchFn: (async () => new Response("no", { status: 402 })) as unknown as typeof fetch });
    await assert.rejects(refuse.placeAlertCall({ number: "+61400000000", alert: "x" }), /answered 402/);
    const none = vapiCalls({ apiKey: "K", phoneNumberId: "p", assistantId: () => null });
    await assert.rejects(none.placeAlertCall({ number: "+61400000000", alert: "x" }), /voice:push/);
  });
});
