import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// The fridge screen's lock. The page is public (the fridge can't log in to anything), so the code is checked HERE,
// on the server, and everything that shows or switches a light needs the session this hands out. The page's own lock
// screen is only a front: skipping it gets you nothing.
//
// The code is the LAST 7 keys pressed, so after a slip you just keep typing. Every key after the 7th is therefore a
// guess, and an attacker could try every code by typing one long stream. So guesses are rate limited per client and
// overall (generous for a person, hopeless for a script), and a client that goes over is locked out for a while.

export const CODE_LENGTH = 7;
const KEYS = /^[0-9*#]+$/;

export const SESSION_IDLE_MS = 5 * 60_000; // unlocked until 5 quiet minutes pass
const MAX_SESSIONS = 20;

const PER_CLIENT_LIMIT = 30; // guesses...
const PER_CLIENT_WINDOW_MS = 5 * 60_000; // ...per 5 minutes
const LOCKOUT_MS = 5 * 60_000; // then locked out this long
const GLOBAL_LIMIT = 200; // guesses from everyone...
const GLOBAL_WINDOW_MS = 10 * 60_000; // ...per 10 minutes

export type Attempt = { ok: true; token: string } | { ok: false; retryAfterSec?: number };

export interface FridgeAuth {
  attempt(client: string, keys: string): Attempt;
  /** True if the token is a live session; also counts as activity (the idle timer restarts). */
  check(token: string | undefined): boolean;
  revoke(token: string | undefined): void;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export function createAuth(opts: { code: string; now?: () => number }): FridgeAuth {
  const now = opts.now ?? Date.now;
  const codeHash = digest(opts.code);
  const sessions = new Map<string, number>(); // token -> expires at
  const tries = new Map<string, number[]>(); // client -> guess times
  const blockedUntil = new Map<string, number>();
  let everyone: number[] = [];

  const recent = (times: number[], windowMs: number) => times.filter((t) => t > now() - windowMs);

  function sweep(): void {
    const t = now();
    for (const [token, expires] of sessions) if (expires <= t) sessions.delete(token);
    for (const [client, until] of blockedUntil) if (until <= t) blockedUntil.delete(client);
  }

  return {
    attempt(client, keys) {
      sweep();
      const t = now();
      const until = blockedUntil.get(client);
      if (until && until > t) return { ok: false, retryAfterSec: Math.ceil((until - t) / 1000) };

      const mine = recent(tries.get(client) ?? [], PER_CLIENT_WINDOW_MS);
      everyone = recent(everyone, GLOBAL_WINDOW_MS);
      if (everyone.length >= GLOBAL_LIMIT) return { ok: false, retryAfterSec: 60 };
      if (mine.length >= PER_CLIENT_LIMIT) {
        blockedUntil.set(client, t + LOCKOUT_MS);
        tries.delete(client);
        return { ok: false, retryAfterSec: Math.ceil(LOCKOUT_MS / 1000) };
      }
      mine.push(t);
      tries.set(client, mine);
      everyone.push(t);

      // Anything that isn't exactly 7 keypad characters is a wrong guess (and counted above).
      const good = keys.length === CODE_LENGTH && KEYS.test(keys) && timingSafeEqual(digest(keys), codeHash);
      if (!good) return { ok: false };

      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string); // drop the oldest
      const token = randomBytes(32).toString("hex");
      sessions.set(token, t + SESSION_IDLE_MS);
      return { ok: true, token };
    },

    check(token) {
      sweep();
      if (!token || !sessions.has(token)) return false;
      sessions.set(token, now() + SESSION_IDLE_MS);
      return true;
    },

    revoke(token) {
      if (token) sessions.delete(token);
    },
  };
}
