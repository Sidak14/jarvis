import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAuth, SESSION_IDLE_MS } from "./auth";
import { haClient, type HaClient, type LightState } from "./ha";
import { LIGHTS, NEVER_SWITCH } from "./lights";
import { createFridgeApp } from "./routes";

const CODE = "1234567"; // test code only
const HOST = "fridge.test";
const MIN = 60_000;

// ---- the lock
describe("fridge auth", () => {
  it("accepts the code and refuses anything else", () => {
    const auth = createAuth({ code: CODE });
    assert.equal(auth.attempt("a", "7654321").ok, false);
    assert.equal(auth.attempt("a", "123456").ok, false); // too short
    assert.equal(auth.attempt("a", "12345678").ok, false); // too long: the page only ever sends the last 7
    assert.equal(auth.attempt("a", "12345ab").ok, false); // not keypad characters
    assert.equal(auth.attempt("a", CODE).ok, true);
  });

  it("works with * and # in the code", () => {
    const auth = createAuth({ code: "08*21#5" });
    assert.equal(auth.attempt("a", "08*21#5").ok, true);
    assert.equal(auth.attempt("a", "08*21#6").ok, false);
  });

  it("a session is live until 5 quiet minutes pass, and activity keeps it alive", () => {
    let t = 1_000_000;
    const auth = createAuth({ code: CODE, now: () => t });
    const r = auth.attempt("a", CODE);
    assert.ok(r.ok);
    const token = r.ok ? r.token : "";
    t += SESSION_IDLE_MS - MIN;
    assert.equal(auth.check(token), true); // activity: the timer restarts
    t += SESSION_IDLE_MS - MIN;
    assert.equal(auth.check(token), true);
    t += SESSION_IDLE_MS + 1;
    assert.equal(auth.check(token), false);
    assert.equal(auth.check(undefined), false);
    assert.equal(auth.check("not-a-token"), false);
  });

  it("revoke ends the session", () => {
    const auth = createAuth({ code: CODE });
    const r = auth.attempt("a", CODE);
    const token = r.ok ? r.token : "";
    auth.revoke(token);
    assert.equal(auth.check(token), false);
  });

  it("locks a client out after 30 guesses in 5 minutes, even for the right code, then lets it back in", () => {
    let t = 0;
    const auth = createAuth({ code: CODE, now: () => t });
    for (let i = 0; i < 30; i++) {
      assert.equal(auth.attempt("a", "0000000").ok, false);
      t += 1000;
    }
    const blocked = auth.attempt("a", CODE);
    assert.equal(blocked.ok, false);
    assert.ok(!blocked.ok && blocked.retryAfterSec && blocked.retryAfterSec > 0);
    t += 4 * MIN;
    assert.equal(auth.attempt("a", CODE).ok, false); // still locked out
    t += 2 * MIN;
    assert.equal(auth.attempt("a", CODE).ok, true); // 5 minutes after the lockout began
  });

  it("an ordinary slip (a dozen keys) never gets near the limit", () => {
    let t = 0;
    const auth = createAuth({ code: CODE, now: () => t });
    for (let i = 0; i < 6; i++) {
      assert.equal(auth.attempt("a", "9999999").ok, false);
      t += 400;
    }
    assert.equal(auth.attempt("a", CODE).ok, true);
  });

  it("one client's lockout does not lock out another", () => {
    const auth = createAuth({ code: CODE });
    for (let i = 0; i < 31; i++) auth.attempt("bad", "0000000");
    assert.equal(auth.attempt("bad", CODE).ok, false);
    assert.equal(auth.attempt("good", CODE).ok, true);
  });

  it("stops guessing from everyone combined (200 in 10 minutes)", () => {
    const auth = createAuth({ code: CODE });
    for (let i = 0; i < 200; i++) auth.attempt(`c${i}`, "0000000");
    const r = auth.attempt("another", CODE);
    assert.equal(r.ok, false);
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

  it("an error from Home Assistant is an error", async () => {
    const ha = haClient("http://ha.test", "T", async () => json({}, 401));
    await assert.rejects(ha.states(["switch.a"]));
    await assert.rejects(ha.setSwitch("switch.a", true));
  });
});

describe("the light list", () => {
  it("never contains a switch that must not be switched, and has unique ids", () => {
    for (const l of LIGHTS) assert.ok(!NEVER_SWITCH.includes(l.entity), `${l.id} is a never-switch entity`);
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
  };
  return { ha, states, switched };
}

const post = (app: ReturnType<typeof createFridgeApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { host: HOST, "content-type": "application/json", "x-fridge": "1", ...headers }, body: JSON.stringify(body) });

/** Unlock and return the Cookie header to send next. */
async function unlock(app: ReturnType<typeof createFridgeApp>, headers: Record<string, string> = {}): Promise<string> {
  const res = await post(app, "/unlock", { keys: CODE }, headers);
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie") ?? "";
  return cookie.split(";")[0];
}

describe("fridge routes", () => {
  const make = (over: Partial<Parameters<typeof createFridgeApp>[0]> = {}) => {
    const f = fakeHa();
    return { ...f, app: createFridgeApp({ code: CODE, ha: f.ha, hosts: [HOST], publicDir: "public", ...over }) };
  };

  it("is off (404) without a code, and refuses other host names", async () => {
    assert.equal((await make({ code: undefined }).app.request("/", { headers: { host: HOST } })).status, 404);
    assert.equal((await make().app.request("/", { headers: { host: "evil.example" } })).status, 403);
    assert.equal((await make().app.request("/", { headers: { host: HOST } })).status, 200);
  });

  it("the locked page has no light names and no code in it, and is never cached or framed", async () => {
    const res = await make().app.request("/", { headers: { host: HOST } });
    const html = await res.text();
    assert.match(html, /Enter code/);
    for (const l of LIGHTS) assert.ok(!html.includes(l.name), `${l.name} is in the locked page`);
    assert.ok(!html.includes(CODE));
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  });

  it("serves its own css and js, and nothing else from /public", async () => {
    const { app } = make();
    for (const f of ["fridge.css", "fridge.js", "dashboard.css"]) assert.equal((await app.request(`/assets/${f}`, { headers: { host: HOST } })).status, 200, f);
    assert.equal((await app.request("/assets/dashboard.js", { headers: { host: HOST } })).status, 404);
    assert.equal((await app.request("/assets/../package.json", { headers: { host: HOST } })).status, 404);
  });

  it("the page's script contains no code", async () => {
    const js = await (await make().app.request("/assets/fridge.js", { headers: { host: HOST } })).text();
    assert.ok(!js.includes(CODE));
  });

  it("without a session the lights can be neither read nor switched", async () => {
    const { app, switched } = make();
    assert.equal((await app.request("/api/lights", { headers: { host: HOST } })).status, 401);
    assert.equal((await post(app, "/api/lights/chandelier", { on: true })).status, 401);
    assert.equal((await post(app, "/api/lights/chandelier", { on: true }, { cookie: "fridge=made-up" })).status, 401);
    assert.deepEqual(switched, []);
  });

  it("a wrong code is refused; the right one sets a safe cookie and opens the lights", async () => {
    const { app } = make();
    assert.equal((await post(app, "/unlock", { keys: "0000000" })).status, 401);
    assert.equal((await post(app, "/unlock", {})).status, 401);
    assert.equal((await post(app, "/unlock", "garbage")).status, 401);
    const ok = await post(app, "/unlock", { keys: CODE });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\/fridge/);
    assert.ok(!/Secure/i.test(cookie)); // plain http on this Mac
    const lights = await app.request("/api/lights", { headers: { host: HOST, cookie: cookie.split(";")[0] } });
    assert.equal(lights.status, 200);
    const body = (await lights.json()) as { lights: { id: string; name: string; icon: string; state: string }[] };
    assert.equal(body.lights.length, LIGHTS.length);
    assert.ok(body.lights.every((l) => ["on", "off", "unavailable"].includes(l.state)));
    assert.ok(!JSON.stringify(body).includes("switch."), "entity ids are not sent to the page");
  });

  it("the cookie is Secure when the request came in over https (the tunnel)", async () => {
    const { app } = make();
    const res = await post(app, "/unlock", { keys: CODE }, { "x-forwarded-proto": "https" });
    assert.match(res.headers.get("set-cookie") ?? "", /Secure/i);
  });

  it("posts must come from the page (X-Fridge header)", async () => {
    const { app } = make();
    const res = await app.request("/unlock", { method: "POST", headers: { host: HOST, "content-type": "application/json" }, body: JSON.stringify({ keys: CODE }) });
    assert.equal(res.status, 403);
    const cookie = await unlock(app);
    const noHeader = await app.request("/api/lights/chandelier", { method: "POST", headers: { host: HOST, cookie, "content-type": "application/json" }, body: JSON.stringify({ on: true }) });
    assert.equal(noHeader.status, 403);
  });

  it("switches exactly the light asked for, on or off", async () => {
    const { app, switched } = make();
    const cookie = await unlock(app);
    assert.equal((await post(app, "/api/lights/chandelier", { on: true }, { cookie })).status, 200);
    assert.equal((await post(app, "/api/lights/khanda", { on: true }, { cookie })).status, 200);
    assert.equal((await post(app, "/api/lights/chandelier", { on: false }, { cookie })).status, 200);
    assert.deepEqual(switched, [
      { entity: "switch.shellyswitch25_c8c9a375a239_channel_1", on: true },
      { entity: "switch.shellyswitch25_c8c9a37a653a_channel_1", on: true },
      { entity: "switch.shellyswitch25_c8c9a375a239_channel_1", on: false },
    ]);
    const lights = (await (await app.request("/api/lights", { headers: { host: HOST, cookie } })).json()) as { lights: { id: string; state: string }[] };
    assert.equal(lights.lights.find((l) => l.id === "khanda")?.state, "on");
    assert.equal(lights.lights.find((l) => l.id === "chandelier")?.state, "off");
  });

  it("refuses unknown lights, raw entity ids, and anything that is not on/off", async () => {
    const { app, switched } = make();
    const cookie = await unlock(app);
    assert.equal((await post(app, "/api/lights/nope", { on: true }, { cookie })).status, 404);
    assert.equal((await post(app, "/api/lights/switch.shellyswitch25_c8c9a37a653a_channel_2", { on: true }, { cookie })).status, 404);
    assert.equal((await post(app, "/api/lights/frontyard-top-lights", { on: true }, { cookie })).status, 404);
    assert.equal((await post(app, "/api/lights/chandelier", { on: "yes" }, { cookie })).status, 400);
    assert.equal((await post(app, "/api/lights/chandelier", {}, { cookie })).status, 400);
    assert.deepEqual(switched, []);
  });

  it("the page can ask whether it is already unlocked, without an error", async () => {
    const { app } = make();
    const before = await app.request("/api/session", { headers: { host: HOST } });
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), { unlocked: false });
    const cookie = await unlock(app);
    const after = await app.request("/api/session", { headers: { host: HOST, cookie } });
    assert.deepEqual(await after.json(), { unlocked: true });
  });

  it("lock ends the session", async () => {
    const { app } = make();
    const cookie = await unlock(app);
    assert.equal((await post(app, "/lock", {}, { cookie })).status, 200);
    assert.equal((await app.request("/api/lights", { headers: { host: HOST, cookie } })).status, 401);
  });

  it("locks a client out after too many wrong guesses, per client address", async () => {
    const { app } = make();
    for (let i = 0; i < 31; i++) await post(app, "/unlock", { keys: "0000000" }, { "cf-connecting-ip": "203.0.113.9" });
    const blocked = await post(app, "/unlock", { keys: CODE }, { "cf-connecting-ip": "203.0.113.9" });
    assert.equal(blocked.status, 429);
    assert.ok(((await blocked.json()) as { retryAfterSec: number }).retryAfterSec > 0);
    assert.equal((await post(app, "/unlock", { keys: CODE }, { "cf-connecting-ip": "198.51.100.7" })).status, 200);
  });

  it("says so when Home Assistant is not set up or not answering", async () => {
    const noHa = make({ ha: null });
    const c1 = await unlock(noHa.app);
    assert.equal((await noHa.app.request("/api/lights", { headers: { host: HOST, cookie: c1 } })).status, 503);
    assert.equal((await post(noHa.app, "/api/lights/chandelier", { on: true }, { cookie: c1 })).status, 503);

    const broken = make({ ha: { states: async () => { throw new Error("down"); }, setSwitch: async () => { throw new Error("down"); } } });
    const c2 = await unlock(broken.app);
    assert.equal((await broken.app.request("/api/lights", { headers: { host: HOST, cookie: c2 } })).status, 502);
    assert.equal((await post(broken.app, "/api/lights/chandelier", { on: true }, { cookie: c2 })).status, 502);
  });
});
