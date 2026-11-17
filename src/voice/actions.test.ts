import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { loadEntities } from "./entities";
import type { HaState, VoiceHa } from "./ha";
import { hashPin } from "./pin";
import type { ToolContext } from "./registry";
import { CallSecurity } from "./session";
import { buildRegistry } from "./tools";
import type { ToolDeps } from "./tools/deps";

const NOW = new Date("2026-11-17T03:30:00Z");
const entities = loadEntities();
const g = entities.garage;
const PIN = "482915";

/** A Home Assistant that reacts: a service call can change a state (or be ignored). */
function world() {
  const states = new Map<string, HaState>();
  const calls: string[] = [];
  const set = (e: string, state: string) => void states.set(e, { state, lastChanged: new Date("2026-11-17T01:30:00Z") });
  set(g.status, "closed");
  set(g.sensor, "off");
  set(g.opener, "on");
  for (const l of entities.lights) set(l.entity, "off");
  const react: { onCall: (domain: string, service: string, entity: string) => void } = { onCall: () => {} };
  const ha: VoiceHa = {
    async read(list) {
      return Object.fromEntries(list.map((e) => [e, states.get(e) ?? { state: "unavailable", lastChanged: null }]));
    },
    async call(domain, service, entity) {
      calls.push(`${domain}.${service} ${entity}`);
      react.onCall(domain, service, entity);
    },
  };
  return { ha, set, calls, react };
}

describe("the Home Assistant write tools", () => {
  let w: ReturnType<typeof world>;
  let writes: "dry" | "live";
  let sec: CallSecurity;
  const ctx = (): ToolContext => ({ callId: "call-1", now: NOW, security: sec });
  const registry = () => buildRegistry({ db: null as never, entities, ha: w.ha, calendar: () => null, writes: () => writes, sleep: async () => {} } as ToolDeps);

  /** Run a tool through the full confirm flow, the way the assistant would: ask, then confirm. */
  async function confirmed(name: string, args: Record<string, unknown> = {}) {
    const reg = registry();
    const ask = await reg.run(name, args, ctx());
    assert.ok(ask.ok);
    const token = (ask.ok ? (ask.result.data as { token?: string }).token : undefined) as string;
    assert.ok(token, "it asked for confirmation");
    const out = await reg.run(name, { ...args, confirm_token: token }, ctx());
    assert.ok(out.ok, JSON.stringify(out));
    return out.ok ? out.result : { speech: "", data: null };
  }

  beforeEach(() => {
    w = world();
    writes = "live";
    sec = new CallSecurity({ now: () => NOW, pinHash: () => hashPin(PIN) });
  });

  it("closing the garage asks first, sends nothing until confirmed, and says what it is about to do", async () => {
    w.set(g.status, "open");
    w.set(g.sensor, "on");
    const ask = await registry().run("close_garage", {}, ctx());
    assert.ok(ask.ok);
    assert.equal(ask.ok && ask.result.speech, "Close the garage door. Shall I go ahead?");
    assert.deepEqual(w.calls, []);
  });

  it("live: closing sends one close command to the garage cover and reports the door closing, then the final state", async () => {
    w.set(g.status, "open");
    w.set(g.sensor, "on");
    w.react.onCall = () => w.set(g.status, "closing");
    const out = await confirmed("close_garage");
    assert.deepEqual(w.calls, ["cover.close_cover cover.garage_door"]);
    assert.match(out.speech, /garage door is closing/);
    assert.equal((out.data as { final: boolean }).final, false);
    w.set(g.status, "closed");
    const status = await registry().run("garage_status", { wait_for: "closed" }, ctx());
    assert.ok(status.ok && /garage door is closed/.test(status.result.speech));
  });

  it("live: if the door never reacts it says so, instead of claiming success", async () => {
    w.set(g.status, "open");
    w.set(g.sensor, "on");
    const out = await confirmed("close_garage");
    assert.deepEqual(w.calls, ["cover.close_cover cover.garage_door"]);
    assert.match(out.speech, /sent the command but the garage door still shows open/);
    assert.equal((out.data as { worked: boolean }).worked, false);
  });

  it("never sends a redundant command, or one while the door is moving, unreadable, or the opener is offline", async () => {
    // already closed
    assert.match((await confirmed("close_garage")).speech, /already closed\. I didn't send anything/);
    // moving
    w.set(g.status, "opening");
    assert.match((await confirmed("close_garage")).speech, /opening already, so I won't press/);
    // unreadable
    w.set(g.status, "unavailable");
    assert.match((await confirmed("close_garage")).speech, /can't read the garage door/);
    // opener offline
    w.set(g.status, "open");
    w.set(g.opener, "off");
    assert.match((await confirmed("close_garage")).speech, /opener isn't answering/);
    assert.deepEqual(w.calls, []);
  });

  it("dry mode says what it would do and sends nothing", async () => {
    writes = "dry";
    w.set(g.status, "open");
    const out = await confirmed("close_garage");
    assert.match(out.speech, /Test mode: I would close the garage door now\. Nothing was sent\./);
    assert.deepEqual(w.calls, []);
    const light = await confirmed("lights_set", { name: "chandelier", state: "on" });
    assert.match(light.speech, /Test mode: I would turn the chandelier on/);
    assert.deepEqual(w.calls, []);
  });

  it("opening the garage needs the PIN first, then a confirmation", async () => {
    const reg = registry();
    const noPin = await reg.run("open_garage", {}, ctx());
    assert.ok(noPin.ok && (noPin.result.data as { needs_pin?: boolean }).needs_pin);
    assert.deepEqual(w.calls, []);
    assert.equal(sec.attempt("call-1", PIN), "ok");
    w.react.onCall = () => w.set(g.status, "opening");
    const out = await confirmed("open_garage");
    assert.deepEqual(w.calls, ["cover.open_cover cover.garage_door"]);
    assert.match(out.speech, /garage door is opening/);
  });

  it("a wrong or locked-out PIN never opens the garage", async () => {
    for (let i = 0; i < 3; i++) sec.attempt("call-1", "000000");
    const out = await registry().run("open_garage", {}, ctx());
    assert.equal(out.ok, false);
    assert.deepEqual(w.calls, []);
  });

  it("a light is switched by name, once, and the final state is read back", async () => {
    w.react.onCall = (_d, service, entity) => w.set(entity, service === "turn_on" ? "on" : "off");
    const out = await confirmed("lights_set", { name: "The Chandelier lights", state: "on" });
    assert.equal(out.speech, "The chandelier is on.");
    assert.deepEqual(w.calls, ["switch.turn_on switch.shellyswitch25_c8c9a375a239_channel_1"]);
    assert.match((await confirmed("lights_set", { name: "chandelier", state: "on" })).speech, /already on\. I didn't send anything/);
    assert.equal(w.calls.length, 1);
  });

  it("a light that does not respond is reported as not responding; an unreachable or unknown one sends nothing", async () => {
    assert.match((await confirmed("lights_set", { name: "driveway", state: "on" })).speech, /still shows off/);
    w.calls.length = 0;
    w.set("switch.smart_plug_backyard_2", "unavailable");
    assert.match((await confirmed("lights_set", { name: "backyard two", state: "on" })).speech, /can't reach/);
    assert.match((await confirmed("lights_set", { name: "kitchen", state: "on" })).speech, /don't know a light called kitchen/);
    assert.deepEqual(w.calls, []);
  });

  it("the main-circuit light cannot be switched by any name, and is not in the tools' world at all", async () => {
    for (const name of ["frontyard top lights", "front yard top", "top lights", "shelly 156"]) {
      const out = await confirmed("lights_set", { name, state: "on" });
      assert.match(out.speech, /don't know a light called/, name);
    }
    assert.deepEqual(w.calls, []);
  });

  it("a confirmation for one light cannot be used for another, or for the garage", async () => {
    const reg = registry();
    const ask = await reg.run("lights_set", { name: "chandelier", state: "on" }, ctx());
    const token = (ask.ok ? (ask.result.data as { token: string }).token : "") as string;
    assert.equal((await reg.run("lights_set", { name: "driveway", state: "on", confirm_token: token }, ctx())).ok, false);
    assert.equal((await reg.run("close_garage", { confirm_token: token }, ctx())).ok, false);
    assert.deepEqual(w.calls, []);
  });
});
