import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { checkCron } from "./cron";
import { decide, type Episode } from "../voice/alerts";
import { appendToPage, flashFrom, JobSchedulesPanel, sameSite, saveGroup, SettingsPanel } from "../ui/settings";
import { DEFS, parseSetting, settings } from "./index";
import { createSettingsTables } from "./schema";

describe("settings", () => {
  beforeEach(() => {
    const db = new Database(":memory:");
    createSettingsTables(db);
    settings.bind(db);
  });
  afterEach(() => settings.unbind());

  it("returns the default until a value is saved, then the saved value, then the default again after a reset", () => {
    assert.equal(settings.num("voice.garage_open_seconds"), 600);
    assert.equal(settings.isCustom("voice.garage_open_seconds"), false);
    assert.equal(settings.set("voice.garage_open_seconds", "45"), null);
    assert.equal(settings.num("voice.garage_open_seconds"), 45);
    assert.equal(settings.isCustom("voice.garage_open_seconds"), true);
    settings.reset("voice.garage_open_seconds");
    assert.equal(settings.num("voice.garage_open_seconds"), 600);
  });

  it("refuses values that are not numbers, too small or too big, or not whole when they must be", () => {
    assert.match(settings.set("voice.garage_open_seconds", "abc")!, /number/);
    assert.match(settings.set("voice.garage_open_seconds", "2")!, /between 10 and/);
    assert.match(settings.set("spotify.window_days", "2.5")!, /whole number/);
    assert.match(settings.set("plans.min_create_confidence", "1.5")!, /between 0 and 1/);
    assert.equal(settings.num("voice.garage_open_seconds"), 600, "nothing was saved");
  });

  it("choices, on/off and unknown keys", () => {
    assert.match(settings.set("voice.ha_writes", "maybe")!, /one of: dry, live/);
    assert.equal(settings.set("voice.ha_writes", "dry"), null);
    assert.equal(settings.str("voice.ha_writes"), "dry");
    assert.equal(settings.set("location.open_on_arrive.mom", "1"), null);
    assert.equal(settings.bool("location.open_on_arrive.mom"), true);
    assert.equal(settings.bool("location.open_on_arrive.me"), true, "me opens by default; Mom and Sukhleen do not");
    assert.equal(parseSetting(DEFS["location.close_on_leave.me"], "off").ok, true);
    assert.throws(() => settings.get("nope.nothing"), /unknown setting/);
  });

  it("a saved value that has become invalid falls back to the default", () => {
    settings.write("voice.garage_open_seconds", "banana");
    assert.equal(settings.num("voice.garage_open_seconds"), 600);
  });

  it("the old hard-coded values are the defaults", () => {
    assert.deepEqual([settings.num("ai.monthly_cap_usd"), settings.num("ai.daily_call_cap"), settings.num("spotify.play_threshold"), settings.num("spotify.window_days")], [10, 100, 4, 2]);
    assert.deepEqual([settings.num("voice.min_gap_minutes"), settings.num("voice.max_calls_per_day"), settings.num("location.leave_wait_seconds"), settings.num("location.left_open_minutes")], [30, 3, 60, 3]);
  });

  it("the lights list refuses the main-circuit light, duplicates and bad entities", () => {
    assert.match(settings.set("home.voice_lights", "top | switch.shellyswitch25_c8c9a37a653a_channel_2")!, /main circuit/);
    assert.match(settings.set("home.voice_lights", "a light | switch.x\nb light | switch.x")!, /twice/);
    assert.match(settings.set("home.voice_lights", "chandelier | not an entity")!, /entity must look like/);
    assert.match(settings.set("home.voice_lights", "just a name")!, /write it as/);
    assert.equal(settings.set("home.voice_lights", "lamp | switch.lamp | desk lamp"), null);
  });

  it("changing a setting changes the rule at once (the alert gap)", () => {
    const ep: Episode = { id: 1, kind: "garage_open", started_at: "2026-11-17T01:00:00Z", last_attempt_at: "2026-11-17T01:00:00Z", attempts_today: 1, attempts_day: "2026-11-17", resolved_at: null, detail: null };
    const later = new Date("2026-11-17T01:10:00Z"); // 10 minutes after the last call
    assert.equal(decide(ep, later, { stillActive: true, budgetCapped: false }).action, "wait");
    settings.set("voice.min_gap_minutes", "5");
    assert.equal(decide(ep, later, { stillActive: true, budgetCapped: false }).action, "call");
  });
});

describe("saving a panel", () => {
  beforeEach(() => {
    const db = new Database(":memory:");
    createSettingsTables(db);
    settings.bind(db);
  });
  afterEach(() => settings.unbind());
  const form = (o: Record<string, string>) => new URLSearchParams(o);

  it("saves what changed, counts it, and does not store a value that equals the default", () => {
    const r = saveGroup("spotify", form({ "s.spotify.play_threshold": "6", "s.spotify.window_days": "2", "s.spotify.like_batch": "40" }));
    assert.deepEqual(r, { saved: 1, errors: [] });
    assert.equal(settings.num("spotify.play_threshold"), 6);
    assert.equal(settings.isCustom("spotify.window_days"), false);
    saveGroup("spotify", form({ "s.spotify.play_threshold": "4" }));
    assert.equal(settings.isCustom("spotify.play_threshold"), false, "back to the default means no override");
  });

  it("reports every bad value by its label, saves the good ones, and ignores other groups", () => {
    const r = saveGroup("plans", form({ "s.plans.min_create_confidence": "9", "s.plans.quiet_minutes": "5", "s.voice.min_gap_minutes": "1" }));
    assert.equal(r.saved, 1);
    assert.match(r.errors[0], /Smallest confidence to create a plan: must be between 0 and 1/);
    assert.equal(settings.isCustom("voice.min_gap_minutes"), false);
  });

  it("the reset box puts a value back; an unticked on/off box saves off", () => {
    settings.set("spotify.window_days", "9");
    saveGroup("spotify", form({ "reset.spotify.window_days": "1" }));
    assert.equal(settings.num("spotify.window_days"), 2);
    const f = new URLSearchParams();
    f.append("s.location.open_on_arrive.me", "0"); // the hidden field only: the box was unticked
    saveGroup("home", f);
    assert.equal(settings.bool("location.open_on_arrive.me"), false);
    const g = new URLSearchParams();
    g.append("s.location.open_on_arrive.me", "0");
    g.append("s.location.open_on_arrive.me", "1"); // hidden + ticked: the last wins
    saveGroup("home", g);
    assert.equal(settings.bool("location.open_on_arrive.me"), true);
  });

  it("only same-site posts are accepted", () => {
    assert.equal(sameSite({ origin: "https://jarvis.gurveerkhalsa.com", host: "jarvis.gurveerkhalsa.com" }), true);
    assert.equal(sameSite({ origin: "https://evil.example", host: "jarvis.gurveerkhalsa.com" }), false);
    assert.equal(sameSite({ host: "localhost:8080", secFetchSite: "cross-site" }), false);
    assert.equal(sameSite({ host: "localhost:8080", secFetchSite: "same-origin" }), true);
    assert.equal(sameSite({ host: "localhost:8080" }), true);
  });

  it("the panel shows the label, the value and the default, escapes text, and is put just before </main>", () => {
    settings.set("spotify.play_threshold", "6");
    const html = SettingsPanel({ group: "spotify", back: "/spotify", flash: flashFrom({ saved: "1" }) }).toString();
    assert.match(html, /Like a track played more than/);
    assert.match(html, /value="6"/);
    assert.match(html, /Default: 4 plays/);
    assert.match(html, /Saved 1 setting\. It is live now\./);
    assert.match(html, /action="\/settings\/save"/);
    assert.equal(appendToPage("<main>x</main>", SettingsPanel({ group: "ai", back: "/" })).includes("settings-ai"), true);
    assert.match(flashFrom({ err: "<b>bad</b>" }).err!, /bad/);
    assert.ok(!SettingsPanel({ group: "ai", back: "/", flash: { err: "<script>x</script>" } }).toString().includes("<script>"));
  });

  it("job schedules: a cron is checked, and the panel lists each job", () => {
    assert.equal(checkCron("*/5 * * * *"), null);
    assert.match(checkCron("every day")!, /not a valid schedule/);
    const html = JobSchedulesPanel({ jobs: [{ name: "plans-poll", expression: "*/10 * * * *", defaultExpression: "*/5 * * * *" }], back: "/jobs" }).toString();
    assert.match(html, /name="cron\.plans-poll"/);
    assert.match(html, /changed/);
  });
});
