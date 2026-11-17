import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { config, ROOT } from "../config";
import { db } from "../db";
import { notify } from "../telegram";
import { budget, budgetAlert, recordUsage } from "./budget";
import { acceptCall, finishCall, logToolCall, maskPhone, registerCall, samePhone, type CallRow } from "./calls";
import { registry as realRegistry } from "./tools";
import type { ToolRegistry } from "./registry";
import { CallSecurity } from "./session";
import { DISABLED_MESSAGE, LIMIT_MESSAGE, STRANGER_MESSAGE } from "./settings";
import { messageOf, parseCall, parseEndReport, parseToolCalls, toolResponse } from "./vapi";

// POST <prefix>/tools   every tool call from the assistant (one endpoint, dispatched by name)
// POST <prefix>/events  status updates, the end-of-call report, and "who is calling?" (assistant-request)
// Vapi sends "Authorization: Bearer <VAPI_WEBHOOK_SECRET>". Anything else gets 401 and no detail.

const sha = (s: string) => createHash("sha256").update(s).digest();

export interface VoiceDeps {
  db: Database.Database;
  registry: ToolRegistry;
  security: CallSecurity;
  enabled: boolean;
  /** Without a secret nothing is accepted. */
  secret: string | undefined;
  ownerPhone: string | undefined;
  /** US$ per month; at 100% the tools stop answering. */
  capUsd: number;
  /** The saved Vapi assistant to connect an accepted caller to. */
  assistantId: () => string | null;
  notify: (text: string, options?: { dedupeKey?: string; cooldownMs?: number; canWait?: boolean }) => unknown;
  /** Called with the finished call (for the alert follow-up: Telegram if nobody answered). */
  onCallEnded?: (call: CallRow) => void;
  now?: () => Date;
  log?: (m: string) => void;
}

const isAuthorized = (header: string | undefined, secret: string | undefined): boolean => {
  const supplied = /^Bearer (.+)$/.exec(header ?? "")?.[1];
  if (!secret || !supplied) return false;
  return timingSafeEqual(sha(supplied), sha(secret)); // hashing first makes the lengths equal
};

const money = (n: number | null) => (n === null ? "" : `, $${n.toFixed(2)}`);

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
    if (budget(deps.db, now(), deps.capUsd).level === "capped") return answer(LIMIT_MESSAGE);
    const items = [];
    for (const r of requests) {
      const started = performance.now();
      const outcome = await deps.registry.run(r.name, r.args, { callId: call!.id, now: now(), security: deps.security });
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
      const row = finishCall(deps.db, call.id, parseEndReport(message), now());
      if (row) {
        if (row.cost_usd !== null) recordUsage(deps.db, row.cost_usd, now());
        const mins = row.duration_s === null ? "" : ` (${row.duration_s}s${money(row.cost_usd)})`;
        deps.notify(`📞 ${row.summary ?? "Call ended."}${mins}`, { canWait: true });
        const warning = budgetAlert(deps.db, now(), deps.capUsd);
        if (warning) deps.notify(warning);
        deps.onCallEnded?.(row);
      }
    }
    return c.json({});
  });

  return app;
}

/** The assistant id that `npm run voice:push` saved. */
export function savedAssistantId(): string | null {
  try {
    const ids = JSON.parse(fs.readFileSync(path.join(ROOT, "voice", ".vapi-ids.json"), "utf8")) as { assistantId?: string };
    return ids.assistantId ?? null;
  } catch {
    return null;
  }
}

export const security = new CallSecurity({
  now: () => new Date(),
  pinHash: () => config.VOICE_PIN_HASH,
  onLocked: () => notify("🔒 Three wrong PINs on a Jarvis phone call. Dangerous tools are locked for that call."),
});

let onCallEnded: ((call: CallRow) => void) | undefined;
/** Set by the alerts module (so routes and alerts do not import each other). */
export const setCallEndedHandler = (fn: (call: CallRow) => void) => {
  onCallEnded = fn;
};

export const voiceRoutes = createVoiceApp({
  db,
  registry: realRegistry,
  security,
  enabled: config.VOICE_ENABLED,
  secret: config.VAPI_WEBHOOK_SECRET,
  ownerPhone: config.OWNER_PHONE,
  capUsd: config.VOICE_MONTHLY_CAP_USD,
  assistantId: savedAssistantId,
  notify,
  onCallEnded: (call) => onCallEnded?.(call),
  log: (m) => console.log(`[voice] ${m}`),
});
