import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { config, ROOT } from "../config";
import { db } from "../db";
import { notify } from "../telegram";
import { acceptCall, finishCall, logToolCall, maskPhone, registerCall, samePhone } from "./calls";
import { registry as realRegistry } from "./tools";
import type { ToolRegistry } from "./registry";
import { DISABLED_MESSAGE, STRANGER_MESSAGE } from "./settings";
import { messageOf, parseCall, parseEndReport, parseToolCalls, toolResponse } from "./vapi";

// POST <prefix>/tools   every tool call from the assistant (one endpoint, dispatched by name)
// POST <prefix>/events  status updates, the end-of-call report, and "who is calling?" (assistant-request)
// Vapi sends "Authorization: Bearer <VAPI_WEBHOOK_SECRET>". Anything else gets 401 and no detail.

const sha = (s: string) => createHash("sha256").update(s).digest();

export interface VoiceDeps {
  db: Database.Database;
  registry: ToolRegistry;
  enabled: boolean;
  /** Without a secret nothing is accepted. */
  secret: string | undefined;
  ownerPhone: string | undefined;
  /** The saved Vapi assistant to connect an accepted caller to. */
  assistantId: () => string | null;
  notify: (text: string, options?: { dedupeKey?: string; cooldownMs?: number }) => unknown;
  now?: () => Date;
  log?: (m: string) => void;
}

const isAuthorized = (header: string | undefined, secret: string | undefined): boolean => {
  const supplied = /^Bearer (.+)$/.exec(header ?? "")?.[1];
  if (!secret || !supplied) return false;
  return timingSafeEqual(sha(supplied), sha(secret)); // hashing first makes the lengths equal
};

export function createVoiceApp(deps: VoiceDeps): Hono {
  const app = new Hono();
  const now = () => (deps.now ?? (() => new Date()))();
  const log = deps.log ?? (() => {});

  app.use("*", async (c, next) => {
    if (!isAuthorized(c.req.header("authorization"), deps.secret)) return c.body(null, 401);
    await next();
  });

  app.post("/tools", async (c) => {
    const body = await c.req.json().catch(() => null);
    const message = messageOf(body);
    if (!message || message.type !== "tool-calls") return c.json({ error: "not a tool call" }, 400);
    const requests = parseToolCalls(message);
    const answer = (error: string) => c.json(toolResponse(requests.map((r) => ({ id: r.id, name: r.name, error }))));
    if (!deps.enabled) return answer(DISABLED_MESSAGE);
    const call = parseCall(message.call);
    if (!acceptCall(deps.db, call, deps.ownerPhone, now())) {
      log("tool call refused: unknown call");
      return answer("I can't do that on this call.");
    }
    const items = [];
    for (const r of requests) {
      const started = performance.now();
      const outcome = await deps.registry.run(r.name, r.args, { callId: call!.id, now: now() });
      logToolCall(deps.db, call!.id, r.name, outcome.ok ? "ok" : "error", performance.now() - started, r.args, now());
      items.push(outcome.ok ? { id: r.id, name: r.name, result: JSON.stringify({ say: outcome.result.speech, data: outcome.result.data ?? null }) } : { id: r.id, name: r.name, error: outcome.error });
    }
    return c.json(toolResponse(items));
  });

  app.post("/events", async (c) => {
    const body = await c.req.json().catch(() => null);
    const message = messageOf(body);
    if (!message) return c.json({ error: "not a Vapi message" }, 400);
    const call = parseCall(message.call);
    log(`event ${message.type}`);

    if (message.type === "assistant-request") {
      if (!deps.enabled) return c.json({ error: DISABLED_MESSAGE });
      if (call && call.direction !== "outbound" && samePhone(call.number, deps.ownerPhone)) {
        const assistantId = deps.assistantId();
        if (!assistantId) return c.json({ error: "Jarvis isn't set up for calls yet." });
        registerCall(deps.db, { id: call.id, direction: "inbound", number: call.number }, now());
        return c.json({ assistantId });
      }
      deps.notify(`📞 Someone phoned the Jarvis number and was turned away (${maskPhone(call?.number)}).`, { dedupeKey: `voice-stranger-${maskPhone(call?.number)}`, cooldownMs: 60 * 60_000 });
      return c.json({ error: STRANGER_MESSAGE });
    }

    if (message.type === "end-of-call-report" && call) {
      finishCall(deps.db, call.id, parseEndReport(message), now());
    }
    return c.json({});
  });

  return app;
}

/** The assistant id that `npm run voice:push` saved. */
function savedAssistantId(): string | null {
  try {
    const ids = JSON.parse(fs.readFileSync(path.join(ROOT, "voice", ".vapi-ids.json"), "utf8")) as { assistantId?: string };
    return ids.assistantId ?? null;
  } catch {
    return null;
  }
}

export const voiceRoutes = createVoiceApp({
  db,
  registry: realRegistry,
  enabled: config.VOICE_ENABLED,
  secret: config.VAPI_WEBHOOK_SECRET,
  ownerPhone: config.OWNER_PHONE,
  assistantId: savedAssistantId,
  notify,
  log: (m) => console.log(`[voice] ${m}`),
});
