import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { checkAccess, dashboardLogin, isHomeNetwork, type AccessDeps } from "./access";
import type { Garage, GarageAction, GarageState } from "./garage";
import { haClient, type HaClient, type LightState } from "./ha";
import { ALL_LIGHTS, LIGHTS, NEVER_SWITCH } from "./lights";
import { CAMERAS } from "./cameras";
import { TV_KEYS, type Tv, type TvKey } from "./tv";
import { createHomeApp } from "./routes";
import { rangeLabel, weekBusy } from "./week";

const HOST = "jarvis.test";
const LOCAL = "127.0.0.1:8080";

// ---- who may open it
const access = (over: Partial<AccessDeps> = {}): AccessDeps => ({ localHosts: [LOCAL], publicHost: HOST, emails: ["me@example.com"], ...over });
/** `from` is the address of the device on the other end of the connection (what the server really sees). */
async function verdict(headers: Record<string, string>, deps = access(), from = "127.0.0.1") {
  const app = new Hono();
  app.get("/", (c) => c.json(checkAccess(c, deps)));
  return (await (await app.request("/", { headers }, { incoming: { socket: { remoteAddress: from } } })).json()) as { verdict: string };
}

describe("dashboard access", () => {
  it("lets in this Mac itself", async () => {
    assert.equal((await verdict({ host: LOCAL })).verdict, "local");
  });

  it("lets in a device on the home network that connects directly, with no login", async () => {
    assert.equal((await verdict({ host: "192.168.1.20:8080" }, access(), "192.168.1.50")).verdict, "lan");
    assert.equal((await verdict({ host: "192.168.1.20:8080" }, access(), "::ffff:10.0.0.7")).verdict, "lan");
  });

  it("does not treat the internet, or a tunnel request, as the home network", async () => {
    assert.equal((await verdict({ host: "192.168.1.20:8080" }, access(), "203.0.113.5")).verdict, "denied");
    // through Cloudflare the connection comes from this Mac, and the header names the real client
    assert.equal((await verdict({ host: HOST, "cf-connecting-ip": "192.168.1.50" }, access(), "192.168.1.50")).verdict, "denied");
    assert.equal((await verdict({ host: "192.168.1.20:8080" }, access(), "")).verdict, "denied");
  });

  it("knows which addresses are home", () => {
    for (const ok of ["192.168.0.4", "10.1.2.3", "172.16.0.1", "172.31.255.1", "::ffff:192.168.1.9", "fe80::1", "fd12::5"]) assert.ok(isHomeNetwork(ok), ok);
    for (const no of ["", "127.0.0.1", "8.8.8.8", "172.32.0.1", "172.15.0.1", "203.0.113.5", "::1"]) assert.ok(!isHomeNetwork(no), no);
  });

  it("lets in an allowed email that Cloudflare Access logged in (any capitals)", async () => {
    const h = { host: HOST, "cf-connecting-ip": "198.51.100.1", "cf-access-jwt-assertion": "x" };
    assert.equal((await verdict({ ...h, "cf-access-authenticated-user-email": "Me@Example.com" })).verdict, "email");
  });

  it("refuses everyone else", async () => {
    const out = { host: HOST, "cf-connecting-ip": "198.51.100.1" };
    assert.equal((await verdict(out)).verdict, "denied"); // not home, not logged in
    assert.equal((await verdict({ ...out, "cf-access-authenticated-user-email": "me@example.com" })).verdict, "denied"); // an email header alone is not a login
    assert.equal((await verdict({ ...out, "cf-access-jwt-assertion": "x", "cf-access-authenticated-user-email": "other@example.com" })).verdict, "denied");
    assert.equal((await verdict({ host: "evil.example", "cf-connecting-ip": "203.0.113.5" })).verdict, "denied");
    assert.equal((await verdict({ host: LOCAL, "cf-connecting-ip": "198.51.100.1" })).verdict, "denied"); // pretending to be local through Cloudflare
    assert.equal((await verdict({ host: HOST })).verdict, "denied"); // no client address
    assert.equal((await verdict({ host: HOST, "cf-connecting-ip": "198.51.100.1", "cf-access-jwt-assertion": "x", "cf-access-authenticated-user-email": "me@example.com" }, access({ emails: [] }))).verdict, "denied");
  });

  it("the middleware answers 403 to a stranger and passes an allowed request on", async () => {
    const app = new Hono();
    app.use("*", dashboardLogin(access()));
    app.get("/", (c) => c.text("hi"));
    assert.equal((await app.request("/", { headers: { host: HOST, "cf-connecting-ip": "198.51.100.1" } })).status, 403);
    assert.equal((await app.request("/", { headers: { host: LOCAL } }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } })).status, 200);
  });
});

// ---- the next 7 days
describe("busy times", () => {
  it("writes ranges the way the fridge shows them", () => {
    assert.equal(rangeLabel(19 * 60, 20 * 60), "7:00 – 8:00 pm");
    assert.equal(rangeLabel(9 * 60, 13 * 60), "9:00 am – 1:00 pm");
    assert.equal(rangeLabel(6 * 60 + 30, 9 * 60 + 15), "6:30 – 9:15 am");
    assert.equal(rangeLabel(0, 30), "12:00 – 12:30 am");
  });

  it("groups events by Sydney day, joins overlaps, cuts a late event at midnight, and marks today", () => {
    const now = new Date("2026-11-17T01:00:00Z"); // Tue 17 Nov, 12pm in Sydney (UTC+11)
    const days = weekBusy(
      [
        { startIso: "2026-11-17T08:00:00Z", endIso: "2026-11-17T09:00:00Z" }, // Tue 7-8pm
        { startIso: "2026-11-17T08:30:00Z", endIso: "2026-11-17T10:00:00Z" }, // overlaps: 7:30-9pm joins to 7-9pm
        { startIso: "2026-11-17T12:00:00Z", endIso: "2026-11-17T14:00:00Z" }, // Tue 11pm to Wed 1am
        { startIso: "2026-11-20T01:00:00Z", endIso: "2026-11-20T04:00:00Z" }, // Fri 12-3pm
      ],
      now,
    );
    assert.equal(days.length, 7);
    assert.deepEqual(days[0], { dow: "Tue", num: 17, month: "Nov", today: true, busy: ["7:00 – 9:00 pm", "11:00 pm – 12:00 am"] });
    assert.deepEqual(days[1].busy, ["12:00 – 1:00 am"]);
    assert.deepEqual(days[2].busy, []);
    assert.deepEqual(days[3], { dow: "Fri", num: 20, month: "Nov", today: false, busy: ["12:00 – 3:00 pm"] });
  });

  it("never includes what the events are", () => {
    const days = weekBusy([{ startIso: "2026-11-17T08:00:00Z", endIso: "2026-11-17T09:00:00Z", summary: "Secret meeting" } as never], new Date("2026-11-17T01:00:00Z"));
    assert.ok(!JSON.stringify(days).includes("Secret"));
  });
});

// ---- Home Assistant client
describe("haClient", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("reads states, calling anything but on/off unavailable, and sends the token", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const ha = haClient("http://ha.test:8123/", "TOKEN", async (url, init) => {
      seen = { url, auth: new Headers(init?.headers).get("authorization") };
      return json([
        { entity_id: "switch.a", state: "on" },
        { entity_id: "switch.b", state: "off" },
        { entity_id: "switch.c", state: "unavailable" },
        { entity_id: "switch.d", state: "unknown" },
      ]);
    });
    const states = await ha.states(["switch.a", "switch.b", "switch.c", "switch.d", "switch.missing"]);
    assert.deepEqual(states, { "switch.a": "on", "switch.b": "off", "switch.c": "unavailable", "switch.d": "unavailable", "switch.missing": "unavailable" });
    assert.equal(seen!.url, "http://ha.test:8123/api/states");
    assert.equal(seen!.auth, "Bearer TOKEN");
  });

  it("turns a switch on and off with the right service", async () => {
    const calls: { url: string; body: string }[] = [];
    const ha = haClient("http://ha.test", "T", async (url, init) => {
      calls.push({ url, body: String(init?.body) });
      return json([]);
    });
    await ha.setSwitch("switch.x", true);
    await ha.setSwitch("switch.x", false);
    assert.deepEqual(calls, [
      { url: "http://ha.test/api/services/switch/turn_on", body: '{"entity_id":"switch.x"}' },
      { url: "http://ha.test/api/services/switch/turn_off", body: '{"entity_id":"switch.x"}' },
    ]);
  });

  it("refuses the switch that trips the main circuit, without calling Home Assistant", async () => {
    let called = false;
    const ha = haClient("http://ha.test", "T", async () => {
      called = true;
      return json([]);
    });
    for (const entity of NEVER_SWITCH) {
      await assert.rejects(ha.setSwitch(entity, true));
      await assert.rejects(ha.setSwitch(entity, false));
    }
    assert.equal(called, false);
  });

  it("reads the garage status and presses Open or Close on the garage cover only", async () => {
    const calls: { url: string; body: string | undefined }[] = [];
    const ha = haClient("http://ha.test", "T", async (url, init) => {
      calls.push({ url, body: init?.body as string | undefined });
      return json(url.includes("binary_sensor") ? { state: "off" } : url.includes("/api/states/") ? { state: "opening" } : []);
    });
    assert.deepEqual(await ha.garage(), { state: "opening", opener: false });
    await ha.pressGarage("open");
    await ha.pressGarage("close");
    assert.deepEqual(calls, [
      { url: "http://ha.test/api/states/sensor.garage_door_status", body: undefined },
      { url: "http://ha.test/api/states/binary_sensor.garage_opener_reachable", body: undefined },
      { url: "http://ha.test/api/services/cover/open_cover", body: '{"entity_id":"cover.garage_door"}' },
      { url: "http://ha.test/api/services/cover/close_cover", body: '{"entity_id":"cover.garage_door"}' },
    ]);
  });

  it("reads the TV, sends a remote key, and turns the TV on through Home Assistant when it is off", async () => {
    const calls: { url: string; body: string | undefined }[] = [];
    let state = "on";
    const ha = haClient("http://ha.test", "T", async (url, init) => {
      calls.push({ url, body: init?.body as string | undefined });
      return json(url.includes("/api/states/") ? { state, attributes: { volume_level: 0.13, is_volume_muted: false, source: "TV", source_list: ["TV", "HDMI"] } } : []);
    });
    assert.deepEqual(await ha.tv(), { state: "on", muted: false, volume: 13, sources: ["TV", "HDMI"], source: "TV" });
    calls.length = 0;
    await ha.tvKey("vol_up");
    assert.deepEqual(calls, [{ url: "http://ha.test/api/services/remote/send_command", body: '{"entity_id":"remote.samsung_the_frame_55_qa55ls03aawxxy","command":"KEY_VOLUP"}' }]);
    state = "off";
    calls.length = 0;
    await ha.tvKey("power");
    assert.equal(calls[calls.length - 1].url, "http://ha.test/api/services/media_player/turn_on");
    assert.equal(await ha.tvSource("Netflix"), false);
    assert.equal(await ha.tvSource("HDMI"), true);
  });

  it("an odd garage status is 'unavailable'", async () => {
    const ha = haClient("http://ha.test", "T", async () => json({ state: "unknown" }));
    assert.deepEqual(await ha.garage(), { state: "unavailable", opener: false });
  });

  it("an error from Home Assistant is an error", async () => {
    const ha = haClient("http://ha.test", "T", async () => json({}, 401));
    await assert.rejects(ha.states(["switch.a"]));
    await assert.rejects(ha.setSwitch("switch.a", true));
  });
});

describe("the light list", () => {
  it("never contains a switch that must not be switched, and has unique ids", () => {
    for (const l of LIGHTS) assert.ok(!NEVER_SWITCH.includes(l.entity), `${l.id} is a never-switch entity`);
    for (const l of ALL_LIGHTS) assert.equal(NEVER_SWITCH.includes(l.entity), l.locked === true, `${l.id}: a never-switch light must be locked, and only those`);
    assert.ok(LIGHTS.every((l) => ALL_LIGHTS.includes(l)));
    assert.equal(new Set(LIGHTS.map((l) => l.id)).size, LIGHTS.length);
    assert.equal(new Set(LIGHTS.map((l) => l.entity)).size, LIGHTS.length);
  });
  it("shows the Khanda Light with the khanda symbol", () => {
    assert.equal(LIGHTS.find((l) => l.id === "khanda")?.icon, "khanda");
  });
});

// ---- the routes
function fakeHa() {
  const states: Record<string, LightState> = {};
  for (const l of LIGHTS) states[l.entity] = "off";
  const switched: { entity: string; on: boolean }[] = [];
  const pressed: GarageAction[] = [];
  const keys: TvKey[] = [];
  const sources: string[] = [];
  const snapshots: string[] = [];
  const tv: Tv = { state: "on", muted: false, volume: 13, sources: ["TV", "HDMI"], source: "TV" };
  let garage: GarageState = "closed";
  const ha: HaClient = {
    async states(entities) {
      const out: Record<string, LightState> = {};
      for (const e of entities) out[e] = states[e] ?? "unavailable";
      return out;
    },
    async setSwitch(entity, on) {
      switched.push({ entity, on });
      states[entity] = on ? "on" : "off";
    },
    async garage() {
      return { state: garage, opener: true } as Garage;
    },
    async pressGarage(action) {
      pressed.push(action);
    },
    async tv() {
      return tv;
    },
    async tvKey(key) {
      keys.push(key);
    },
    async tvSource(source) {
      if (!tv.sources.includes(source)) return false;
      sources.push(source);
      return true;
    },
    async snapshot(entity) {
      snapshots.push(entity);
      return { type: "image/jpeg", body: new TextEncoder().encode("jpeg-bytes").buffer as ArrayBuffer };
    },
  };
  return { ha, states, switched, pressed, keys, sources, snapshots, setGarage: (g: GarageState) => (garage = g) };
}

const IN = { host: LOCAL }; // this Mac: let in
const post = (app: ReturnType<typeof createHomeApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { ...IN, "content-type": "application/json", "x-fridge": "1", ...headers }, body: JSON.stringify(body) });

describe("home screen routes", () => {
  const make = (over: Partial<Parameters<typeof createHomeApp>[0]> = {}) => {
    const f = fakeHa();
    return {
      ...f,
      app: createHomeApp({
        access: access(),
        ha: f.ha,
        people: () => [{ name: "Gurveer", where: "Gym" }],
        week: async () => weekBusy([], new Date("2026-11-17T01:00:00Z")),
        publicDir: "public",
        ...over,
      }),
    };
  };

  it("refuses a stranger on every route, and serves the page to someone allowed", async () => {
    const { app, switched } = make();
    const stranger = { host: HOST, "cf-connecting-ip": "198.51.100.1" };
    for (const path of ["/", "/api/state", "/api/week", "/assets/fridge.js"]) assert.equal((await app.request(path, { headers: stranger })).status, 403, path);
    assert.equal((await app.request("/api/lights/chandelier", { method: "POST", headers: { ...stranger, "x-fridge": "1" }, body: JSON.stringify({ on: true }) })).status, 403);
    assert.deepEqual(switched, []);
    assert.equal((await app.request("/", { headers: IN })).status, 200);
  });

  it("the page is an empty frame: no code, no light names, never cached or framed", async () => {
    const res = await make().app.request("/", { headers: IN });
    const html = await res.text();
    assert.doesNotMatch(html, /Enter code/);
    for (const l of LIGHTS) assert.ok(!html.includes(l.name), `${l.name} is in the page`);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  });

  it("serves its own css and js, and nothing else from /public", async () => {
    const { app } = make();
    for (const f of ["fridge.css", "home.js", "home-common.js"]) assert.equal((await app.request(`/assets/${f}`, { headers: IN })).status, 200, f);
    assert.equal((await app.request("/assets/dashboard.css", { headers: IN })).status, 404);
    assert.equal((await app.request("/assets/../package.json", { headers: IN })).status, 404);
  });

  it("state has the lights, the garage and where people are, without entity ids", async () => {
    const { app } = make();
    const body = (await (await app.request("/api/state", { headers: IN })).json()) as { lights: { id: string; state: string }[]; garage: unknown; people: { name: string; where: string }[] };
    assert.equal(body.lights.length, LIGHTS.length);
    assert.ok(body.lights.every((l) => ["on", "off", "unavailable"].includes(l.state)));
    assert.deepEqual(body.garage, { state: "closed", opener: true });
    assert.deepEqual(body.people, [{ name: "Gurveer", where: "Gym" }]);
    assert.ok(!JSON.stringify(body).includes("switch."));
  });

  it("the week is the next 7 days, and a calendar problem is shown, not hidden", async () => {
    const ok = (await (await make().app.request("/api/week", { headers: IN })).json()) as { days: unknown[] };
    assert.equal(ok.days.length, 7);
    const bad = make({ week: async () => { throw new Error("Google Calendar isn't connected"); } });
    const res = await bad.app.request("/api/week", { headers: IN });
    assert.equal(res.status, 502);
    assert.match(((await res.json()) as { error: string }).error, /isn't connected/);
  });

  it("posts must come from the page (X-Fridge header)", async () => {
    const { app, switched, pressed } = make();
    const send = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { ...IN, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await send("/api/lights/chandelier", { on: true })).status, 403);
    assert.equal((await send("/api/garage", { action: "open" })).status, 403);
    assert.deepEqual([switched, pressed], [[], []]);
  });

  it("switches exactly the light asked for, on or off", async () => {
    const { app, switched } = make();
    assert.equal((await post(app, "/api/lights/chandelier", { on: true })).status, 200);
    assert.equal((await post(app, "/api/lights/khanda", { on: true })).status, 200);
    assert.equal((await post(app, "/api/lights/chandelier", { on: false })).status, 200);
    assert.deepEqual(switched, [
      { entity: "switch.shellyswitch25_c8c9a375a239_channel_1", on: true },
      { entity: "switch.shellyswitch25_c8c9a37a653a_channel_1", on: true },
      { entity: "switch.shellyswitch25_c8c9a375a239_channel_1", on: false },
    ]);
  });

  it("refuses unknown lights, raw entity ids, and anything that is not on/off", async () => {
    const { app, switched } = make();
    assert.equal((await post(app, "/api/lights/nope", { on: true })).status, 404);
    assert.equal((await post(app, "/api/lights/switch.shellyswitch25_c8c9a37a653a_channel_2", { on: true })).status, 404);
    assert.equal((await post(app, "/api/lights/frontyard-top-lights", { on: true })).status, 404);
    assert.equal((await post(app, "/api/lights/frontyard-top", { on: true })).status, 403, "listed, but locked");
    assert.equal((await post(app, "/api/lights/chandelier", { on: "yes" })).status, 400);
    assert.equal((await post(app, "/api/lights/chandelier", {})).status, 400);
    assert.deepEqual(switched, []);
  });

  it("presses the garage only for open or close", async () => {
    const { app, pressed } = make();
    assert.equal((await post(app, "/api/garage", { action: "open" })).status, 200);
    assert.equal((await post(app, "/api/garage", { action: "close" })).status, 200);
    assert.equal((await post(app, "/api/garage", { action: "stop" })).status, 400);
    assert.equal((await post(app, "/api/garage", { action: "toggle" })).status, 400);
    assert.equal((await post(app, "/api/garage", {})).status, 400);
    assert.deepEqual(pressed, ["open", "close"]);
  });

  it("the Lights page lists every light, with the locked one shown as locked and no entity ids", async () => {
    const { app } = make();
    const body = (await (await app.request("/api/lights", { headers: IN })).json()) as { lights: { id: string; state: string; locked: boolean }[] };
    assert.equal(body.lights.length, ALL_LIGHTS.length);
    assert.ok(body.lights.length > LIGHTS.length);
    assert.deepEqual(body.lights.filter((l) => l.locked).map((l) => [l.id, l.state]), [["frontyard-top", "locked"]]);
    assert.ok(!JSON.stringify(body).includes("switch."));
  });

  it("switches an extra light that is only on the Lights page", async () => {
    const { app, switched } = make();
    assert.equal((await post(app, "/api/lights/entrance", { on: true })).status, 200);
    assert.deepEqual(switched, [{ entity: "switch.shellyswitch25_c8c9a375c8b2_channel_2", on: true }]);
  });

  it("each page is served, with the tabs, and a stranger can't see any of them", async () => {
    const { app } = make();
    for (const [path, word] of [["/lights", "All lights"], ["/tv", "Power"], ["/cameras", "Cameras"]] as const) {
      const html = await (await app.request(path, { headers: IN })).text();
      assert.ok(html.includes(word), path);
      assert.ok(html.includes('href="/dashboard/tv"') && html.includes('href="/dashboard/cameras"') && html.includes('href="/dashboard/lights"'), `${path} has the tabs`);
      assert.equal((await app.request(path, { headers: { host: HOST, "cf-connecting-ip": "198.51.100.1" } })).status, 403);
    }
    for (const f of ["home-common.js", "home.js", "lights.js", "tv.js", "cameras.js"]) assert.equal((await app.request(`/assets/${f}`, { headers: IN })).status, 200, f);
  });

  it("sends only the TV keys it knows, and only inputs the TV lists", async () => {
    const { app, keys, sources } = make();
    for (const k of Object.keys(TV_KEYS)) assert.equal((await post(app, "/api/tv", { key: k })).status, 200, k);
    assert.equal(keys.length, Object.keys(TV_KEYS).length);
    keys.length = 0;
    assert.equal((await post(app, "/api/tv", { key: "KEY_POWER" })).status, 400, "raw codes are refused");
    assert.equal((await post(app, "/api/tv", { key: "factory_reset" })).status, 400);
    assert.equal((await post(app, "/api/tv", {})).status, 400);
    assert.equal((await post(app, "/api/tv", { source: "Netflix" })).status, 400);
    assert.equal((await post(app, "/api/tv", { source: "HDMI" })).status, 200);
    assert.deepEqual([keys, sources], [[], ["HDMI"]]);
    const noHeader = await app.request("/api/tv", { method: "POST", headers: { ...IN, "content-type": "application/json" }, body: JSON.stringify({ key: "up" }) });
    assert.equal(noHeader.status, 403);
    const state = (await (await app.request("/api/tv", { headers: IN })).json()) as { tv: Tv };
    assert.equal(state.tv.volume, 13);
  });

  it("shows camera pictures for known cameras only, keeps them a moment, and never the token or entity", async () => {
    const { app, snapshots } = make();
    const list = JSON.stringify(await (await app.request("/api/cameras", { headers: IN })).json());
    assert.ok(!list.includes("camera.dahua"));
    const one = await app.request("/api/camera/cam1", { headers: IN });
    assert.equal(one.status, 200);
    assert.equal(one.headers.get("content-type"), "image/jpeg");
    assert.equal(await one.text(), "jpeg-bytes");
    await app.request("/api/camera/cam1", { headers: IN });
    assert.deepEqual(snapshots, [CAMERAS[0].entity], "the second look came from the short keep");
    assert.equal((await app.request("/api/camera/camera.dahua_mediaprofile_channel2_substream1", { headers: IN })).status, 404);
    assert.equal((await app.request("/api/camera/nope", { headers: IN })).status, 404);
  });

  it("does not press the garage when the sensor or the opener can't be read", async () => {
    const f = fakeHa();
    const app = createHomeApp({ access: access(), ha: { ...f.ha, garage: async () => ({ state: "closed", opener: false }) }, people: () => [], week: async () => [], publicDir: "public" });
    assert.equal((await post(app, "/api/garage", { action: "open" })).status, 409);
    const app2 = createHomeApp({ access: access(), ha: { ...f.ha, garage: async () => ({ state: "unavailable", opener: true }) }, people: () => [], week: async () => [], publicDir: "public" });
    assert.equal((await post(app2, "/api/garage", { action: "open" })).status, 409);
    assert.deepEqual(f.pressed, []);
  });

  it("says so when Home Assistant is not set up or not answering", async () => {
    const noHa = make({ ha: null });
    const state = (await (await noHa.app.request("/api/state", { headers: IN })).json()) as { error: string; people: unknown[] };
    assert.match(state.error, /isn't set up/);
    assert.equal(state.people.length, 1, "people still show");
    assert.equal((await post(noHa.app, "/api/lights/chandelier", { on: true })).status, 503);
    assert.equal((await post(noHa.app, "/api/garage", { action: "open" })).status, 503);

    const down = async () => { throw new Error("down"); };
    const broken = make({ ha: { states: down, setSwitch: down, garage: down, pressGarage: down, tv: down, tvKey: down, tvSource: down, snapshot: down } });
    const body = (await (await broken.app.request("/api/state", { headers: IN })).json()) as { error: string };
    assert.match(body.error, /isn't answering/);
    assert.equal((await post(broken.app, "/api/lights/chandelier", { on: true })).status, 502);
    assert.equal((await post(broken.app, "/api/garage", { action: "open" })).status, 502);
  });
});
