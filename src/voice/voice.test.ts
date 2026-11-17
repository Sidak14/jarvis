import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { z } from "zod";
import { getCall } from "./calls";
import { defineTool, ToolRegistry } from "./registry";
import { createVoiceApp, type VoiceDeps } from "./routes";
import { createVoiceTables } from "./schema";
import { buildRegistry } from "./tools";
import { loadEntities } from "./entities";

const realRegistry = buildRegistry({ db: null as never, entities: loadEntities(), ha: null, calendar: () => null, writes: () => "dry" });
import { parseToolCalls } from "./vapi";
import { CallSecurity } from "./session";

const SECRET = "s".repeat(40);
const OWNER = "+61405642326";
const NOW = new Date("2026-11-17T03:30:00Z"); // 2:30pm in Sydney

describe("voice routes", () => {
  let db: Database.Database;
  let alerts: string[];
  const make = (over: Partial<VoiceDeps> = {}) =>
    createVoiceApp({ db, registry: realRegistry, security: new CallSecurity({ now: () => NOW, pinHash: () => undefined }), capUsd: 10, enabled: true, secret: SECRET, ownerPhone: OWNER, assistantId: () => "asst-1", notify: (t) => void alerts.push(t), now: () => NOW, ...over });
  const post = (app: ReturnType<typeof make>, path: string, body: unknown, auth: string | null = `Bearer ${SECRET}`) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });
  const toolMsg = (name: string, o: { call?: object; args?: unknown; id?: string } = {}) => ({
    message: {
      type: "tool-calls",
      call: o.call ?? { id: "call-1", type: "inboundPhoneCall", customer: { number: OWNER } },
      toolCallList: [{ id: o.id ?? "tc-1", type: "function", function: { name, arguments: o.args ?? {} } }],
    },
  });

  beforeEach(() => {
    db = new Database(":memory:");
    createVoiceTables(db);
    alerts = [];
  });

  it("answers 401 with no body to anything without the right secret", async () => {
    const app = make();
    for (const auth of [null, "Bearer wrong", `Bearer ${SECRET}x`, SECRET, "Basic abc"]) {
      for (const path of ["/tools", "/events"]) {
        const res = await post(app, path, toolMsg("ping"), auth);
        assert.equal(res.status, 401);
        assert.equal(await res.text(), "");
      }
    }
    assert.equal((await post(make({ secret: undefined }), "/tools", toolMsg("ping"), "Bearer undefined")).status, 401, "no secret configured: nothing is accepted");
  });

  it("runs the ping tool and answers the way Vapi wants (200, results, a flat string)", async () => {
    const res = await post(make(), "/tools", toolMsg("ping"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { results: { toolCallId: string; result: string }[] };
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].toolCallId, "tc-1");
    assert.equal(typeof body.results[0].result, "string");
    const result = JSON.parse(body.results[0].result) as { say: string };
    assert.match(result.say, /2:30 pm/i);
    assert.match(result.say, /Tuesday/);
  });

  it("logs the tool call without its arguments, and remembers the call", async () => {
    await post(make(), "/tools", toolMsg("ping", { args: { pin: "1234" } }));
    const rows = db.prepare(`SELECT tool, status, arg_names FROM voice_tool_calls`).all() as { tool: string; status: string; arg_names: string | null }[];
    assert.deepEqual(rows, [{ tool: "ping", status: "ok", arg_names: "pin" }]);
    assert.ok(!JSON.stringify(db.prepare(`SELECT * FROM voice_tool_calls`).all()).includes("1234"), "the value is never stored");
    assert.equal(getCall(db, "call-1")?.direction, "inbound");
  });

  it("a tool that does not exist does not run; bad arguments are refused", async () => {
    const unknown = (await (await post(make(), "/tools", toolMsg("launch_missiles"))).json()) as { results: { error?: string }[] };
    assert.ok(unknown.results[0].error);
    const strict = new ToolRegistry([defineTool({ name: "t", description: "d", schema: z.object({ n: z.number() }), risk: "read", timeoutMs: 1000, handler: () => ({ speech: "ok" }) })]);
    const bad = (await (await post(make({ registry: strict }), "/tools", toolMsg("t", { args: { n: "x" } }))).json()) as { results: { error?: string }[] };
    assert.ok(bad.results[0].error);
    const good = (await (await post(make({ registry: strict }), "/tools", toolMsg("t", { args: { n: 3 } }))).json()) as { results: { result?: string }[] };
    assert.ok(good.results[0].result);
  });

  it("refuses tool calls from a call it does not know, unless it is an inbound call from the owner", async () => {
    const stranger = { id: "call-x", type: "inboundPhoneCall", customer: { number: "+61400000000" } };
    const outbound = { id: "call-y", type: "outboundPhoneCall", customer: { number: OWNER } };
    for (const call of [stranger, outbound, { id: "call-z" }]) {
      const res = (await (await post(make(), "/tools", toolMsg("ping", { call }))).json()) as { results: { error?: string }[] };
      assert.ok(res.results[0].error, JSON.stringify(call));
    }
    assert.equal(db.prepare(`SELECT COUNT(*) FROM voice_calls`).pluck().get(), 0);
    assert.equal(db.prepare(`SELECT COUNT(*) FROM voice_tool_calls`).pluck().get(), 0);
  });

  it("a tool that takes too long answers 'took too long', and one that throws answers 'didn't work'", async () => {
    const slow = new ToolRegistry([
      defineTool({ name: "slow", description: "d", schema: z.object({}), risk: "read", timeoutMs: 30, handler: () => new Promise(() => {}) }),
      defineTool({ name: "boom", description: "d", schema: z.object({}), risk: "read", timeoutMs: 30, handler: () => { throw new Error("secret detail"); } }),
    ]);
    const app = make({ registry: slow });
    const a = (await (await post(app, "/tools", toolMsg("slow"))).json()) as { results: { error: string }[] };
    assert.match(a.results[0].error, /too long/);
    const b = (await (await post(app, "/tools", toolMsg("boom"))).json()) as { results: { error: string }[] };
    assert.match(b.results[0].error, /didn't work/);
    assert.ok(!b.results[0].error.includes("secret detail"));
  });

  it("accepts arguments as an object or as a JSON string", () => {
    const msg = { toolCallList: [{ id: "a", function: { name: "x", arguments: { n: 1 } } }, { id: "b", function: { name: "y", arguments: '{"n":2}' } }, { id: "c", function: { name: "z", arguments: "nonsense" } }, { noid: true }] };
    assert.deepEqual(parseToolCalls(msg), [{ id: "a", name: "x", args: { n: 1 } }, { id: "b", name: "y", args: { n: 2 } }, { id: "c", name: "z", args: null }]);
  });

  it("assistant-request: my number gets the assistant, a stranger is turned away and I am told", async () => {
    const ok = (await (await post(make(), "/events", { message: { type: "assistant-request", call: { id: "c1", type: "inboundPhoneCall", customer: { number: "+61 405 642 326" } } } })).json()) as { assistantId?: string };
    assert.equal(ok.assistantId, "asst-1");
    assert.equal(getCall(db, "c1")?.direction, "inbound");
    const no = (await (await post(make(), "/events", { message: { type: "assistant-request", call: { id: "c2", type: "inboundPhoneCall", customer: { number: "+61411222333" } } } })).json()) as { assistantId?: string; error?: string };
    assert.equal(no.assistantId, undefined);
    assert.ok(no.error);
    assert.equal(getCall(db, "c2"), undefined);
    assert.equal(alerts.length, 1);
    assert.ok(!alerts[0].includes("411222333"), "the number is masked in the alert");
  });

  it("the end-of-call report closes the call with its cost and a one-line summary", async () => {
    const app = make();
    await post(app, "/tools", toolMsg("ping"));
    await post(app, "/events", { message: { type: "end-of-call-report", endedReason: "customer-ended-call", cost: 0.1234, startedAt: "2026-11-17T03:30:00Z", endedAt: "2026-11-17T03:31:12Z", call: { id: "call-1", type: "inboundPhoneCall" } } });
    const row = getCall(db, "call-1")!;
    assert.equal(row.duration_s, 72);
    assert.equal(row.cost_usd, 0.1234);
    assert.equal(row.ended_reason, "customer-ended-call");
    assert.equal(row.summary, "You called Jarvis: used ping; ended: customer-ended-call.");
  });

  it("when voice is switched off it refuses politely", async () => {
    const app = make({ enabled: false });
    const t = (await (await post(app, "/tools", toolMsg("ping"))).json()) as { results: { error: string }[] };
    assert.match(t.results[0].error, /switched off/);
    const e = (await (await post(app, "/events", { message: { type: "assistant-request", call: { id: "c1", type: "inboundPhoneCall", customer: { number: OWNER } } } })).json()) as { error: string };
    assert.match(e.error, /switched off/);
    assert.equal(db.prepare(`SELECT COUNT(*) FROM voice_calls`).pluck().get(), 0);
  });
});

describe("the tool registry", () => {
  it("describes every tool as JSON Schema for the assistant", () => {
    const defs = realRegistry.definitions();
    assert.deepEqual(defs.map((d) => d.name), realRegistry.names());
    for (const d of defs) {
      assert.equal(d.parameters.type, "object");
      assert.ok(!("$schema" in d.parameters));
      assert.ok(d.description.length > 10);
    }
  });
  it("refuses a duplicate name", () => {
    const t = defineTool({ name: "a", description: "d", schema: z.object({}), risk: "read", timeoutMs: 1, handler: () => ({ speech: "" }) });
    assert.throws(() => new ToolRegistry([t, t]));
  });
});
