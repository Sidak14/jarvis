import { randomBytes } from "node:crypto";
import { verifyPin } from "./pin";

// What Jarvis remembers about ONE call while it is going on, in memory only: whether the PIN was given, how many wrong tries,
// and the confirmation tokens it has handed out. None of it is decided by the model: a token is made and checked here.

export const PIN_MAX_TRIES = 3;
export const PIN_VALID_MS = 10 * 60_000;
export const CONFIRM_TTL_MS = 60_000;
const FORGET_AFTER_MS = 60 * 60_000;

interface Pending {
  tool: string;
  argsKey: string;
  expires: number;
}
interface CallState {
  failures: number;
  locked: boolean;
  pinUntil: number;
  tokens: Map<string, Pending>;
  touched: number;
}

export type PinResult = "ok" | "wrong" | "locked" | "no_pin";

export class CallSecurity {
  private calls = new Map<string, CallState>();

  constructor(private opts: { now: () => Date; pinHash: () => string | undefined; onLocked?: (callId: string) => void }) {}

  private state(callId: string): CallState {
    const t = this.opts.now().getTime();
    for (const [id, s] of this.calls) if (t - s.touched > FORGET_AFTER_MS) this.calls.delete(id);
    let s = this.calls.get(callId);
    if (!s) this.calls.set(callId, (s = { failures: 0, locked: false, pinUntil: 0, tokens: new Map(), touched: t }));
    s.touched = t;
    return s;
  }

  /** Too many wrong PINs: dangerous tools stay locked for the rest of the call. */
  locked(callId: string): boolean {
    return this.state(callId).locked;
  }

  /** Has the right PIN been given in the last 10 minutes (and not locked)? */
  pinValid(callId: string): boolean {
    const s = this.state(callId);
    return !s.locked && s.pinUntil > this.opts.now().getTime();
  }

  attempt(callId: string, pin: string): PinResult {
    const s = this.state(callId);
    if (s.locked) return "locked";
    const hash = this.opts.pinHash();
    if (!hash) return "no_pin";
    if (verifyPin(pin, hash)) {
      s.failures = 0;
      s.pinUntil = this.opts.now().getTime() + PIN_VALID_MS;
      return "ok";
    }
    s.failures++;
    if (s.failures >= PIN_MAX_TRIES) {
      s.locked = true;
      s.pinUntil = 0;
      this.opts.onLocked?.(callId);
      return "locked";
    }
    return "wrong";
  }

  /** A one-use token for this exact action on this call, good for 60 seconds. */
  issue(callId: string, tool: string, argsKey: string): string {
    const s = this.state(callId);
    const now = this.opts.now().getTime();
    for (const [token, p] of s.tokens) if (p.expires <= now) s.tokens.delete(token);
    const token = randomBytes(4).toString("hex");
    s.tokens.set(token, { tool, argsKey, expires: now + CONFIRM_TTL_MS });
    return token;
  }

  /** True once, and only for the same tool with the same arguments on the same call, within 60 seconds. */
  consume(callId: string, token: string, tool: string, argsKey: string): boolean {
    const s = this.state(callId);
    const p = s.tokens.get(token);
    s.tokens.delete(token);
    return !!p && p.tool === tool && p.argsKey === argsKey && p.expires > this.opts.now().getTime();
  }
}
