import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { loadEntities } from "./entities";
import type { HaState, VoiceHa } from "./ha";
import type { ToolContext } from "./registry";
import { CallSecurity } from "./session";
import { buildRegistry } from "./tools";
import type { ToolDeps } from "./tools/deps";

const NOW = new Date("2026-11-17T03:30:00Z");
const entities = loadEntities();
const g = entities.garage;
const PHRASE = "open sesame";

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

  const started: string[] = [];
  const registry = () => buildRegistry({ db: null as never, entities, ha: w.ha, calendar: () => null, writes: () => writes, sleep: async () => {}, afterMove: (id, want) => void started.push(`${id} ${want}`) } as ToolDeps);

  /** Run a tool the way the assistant would: one call, straight away. */
  async function run(name: string, args: Record<string, unknown> = {}) {
    const out = await registry().run(name, args, ctx());
    assert.ok(out.ok, JSON.stringify(out));
    return out.ok ? out.result : { speech: "", data: null };
  }

  beforeEach(() => {
    w = world();
    writes = "live";
    sec = new CallSecurity({ now: () => NOW, phrase: () => PHRASE });
    started.length = 0;
  });

  it("closing the garage acts at once, with no confirmation, and answers while the door is still moving", async () => {
    w.set(g.status, "open");
    w.set(g.sensor, "on");
    w.react.onCall = () => w.set(g.status, "closing");
    const out = await run("close_garage");
    assert.deepEqual(w.calls, ["cover.close_cover cover.garage_door"]);
    assert.equal(out.speech, "The garage door is closing now.");
    assert.equal((out.data as { final: boolean }).final, false);
    assert.deepEqual(started, ["call-1 closed"], "the watcher was started for this call");
  });

  it("if the door never reacts it says so, instead of claiming success or watching", async () => {
    w.set(g.status, "open");
    w.set(g.sensor, "on");
    const out = await run("close_garage");
    assert.deepEqual(w.calls, ["cover.close_cover cover.garage_door"]);
    assert.match(out.speech, /didn't go through: the garage door still shows open/);
    assert.equal((out.data as { worked: boolean }).worked, false);
    assert.deepEqual(started, []);
  });

  it("never sends a redundant command, or one while the door is moving, unreadable, or the opener is offline", async () => {
    // already closed
    assert.match((await run("close_garage")).speech, /already closed\. I didn't send anything/);
    // moving
    w.set(g.status, "opening");
    assert.match((await run("close_garage")).speech, /opening already, so I won't press/);
    // unreadable
    w.set(g.status, "unavailable");
    assert.match((await run("close_garage")).speech, /can't read the garage door/);
    // opener offline
    w.set(g.status, "open");
    w.set(g.opener, "off");
    assert.match((await run("close_garage")).speech, /opener isn't answering/);
    assert.deepEqual(w.calls, []);
  });

  it("dry mode says what it would do and sends nothing", async () => {
    writes = "dry";
    w.set(g.status, "open");
    const out = await run("close_garage");
    assert.match(out.speech, /Test mode: I would close the garage door now\. Nothing was sent\./);
    assert.deepEqual(w.calls, []);
    const light = await run("lights_set", { name: "chandelier", state: "on" });
    assert.match(light.speech, /Test mode: I would turn the chandelier on/);
    assert.deepEqual(w.calls, []);
  });

  it("opening works only when the words contain the passphrase", async () => {
    w.react.onCall = () => w.set(g.status, "opening");
    const plain = await run("open_garage", { words: "open the garage please" });
    assert.equal(plain.speech, "I can't open the garage door.");
    assert.deepEqual(w.calls, []);
    const none = await run("open_garage");
    assert.equal(none.speech, "I can't open the garage door.");
    const ok = await run("open_garage", { words: "Jarvis, open sesame" });
    assert.deepEqual(w.calls, ["cover.open_cover cover.garage_door"]);
    assert.match(ok.speech, /garage door is opening/);
    assert.deepEqual(started, ["call-1 open"]);
  });

  it("the refusal never says what would work, and three misses lock the call even for the right words", async () => {
    const out = await run("open_garage", { words: "open it" });
    assert.ok(!/sesame|phrase|password|pin/i.test(JSON.stringify(out)));
    await run("open_garage", { words: "open it" });
    await run("open_garage", { words: "open it" });
    assert.equal((await run("open_garage", { words: "open sesame" })).speech, "I can't open the garage door.");
    assert.deepEqual(w.calls, []);
  });

  it("a light is switched by name, once, and the final state is read back", async () => {
    w.react.onCall = (_d, service, entity) => w.set(entity, service === "turn_on" ? "on" : "off");
    const out = await run("lights_set", { name: "The Chandelier lights", state: "on" });
    assert.equal(out.speech, "The chandelier is on.");
    assert.deepEqual(w.calls, ["switch.turn_on switch.shellyswitch25_c8c9a375a239_channel_1"]);
    assert.match((await run("lights_set", { name: "chandelier", state: "on" })).speech, /already on\. I didn't send anything/);
    assert.equal(w.calls.length, 1);
  });

  it("a light that does not respond is reported as not responding; an unreachable or unknown one sends nothing", async () => {
    assert.match((await run("lights_set", { name: "driveway", state: "on" })).speech, /still shows off/);
    w.calls.length = 0;
    w.set("switch.smart_plug_backyard_2", "unavailable");
    assert.match((await run("lights_set", { name: "backyard two", state: "on" })).speech, /can't reach/);
    assert.match((await run("lights_set", { name: "kitchen", state: "on" })).speech, /don't know a light called kitchen/);
    assert.deepEqual(w.calls, []);
  });

  it("the main-circuit light cannot be switched by any name, and is not in the tools' world at all", async () => {
    for (const name of ["frontyard top lights", "front yard top", "top lights", "shelly 156"]) {
      const out = await run("lights_set", { name, state: "on" });
      assert.match(out.speech, /don't know a light called/, name);
    }
    assert.deepEqual(w.calls, []);
  });
});
