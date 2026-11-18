// What Jarvis remembers about ONE call while it is going on, in memory only: how many times the garage passphrase was
// wrong. The check is made here, in code, never by the model. The passphrase itself is VOICE_OPEN_PHRASE in .env.

export const PHRASE_MAX_TRIES = 3;
const FORGET_AFTER_MS = 60 * 60_000;

interface CallState {
  failures: number;
  locked: boolean;
  touched: number;
}

export type PhraseResult = "ok" | "wrong" | "locked" | "no_phrase";

/** Lower case, letters and digits only, single spaces: "Open, sesame!" and "open sesame" are the same words. */
export const normaliseWords = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export class CallSecurity {
  private calls = new Map<string, CallState>();

  constructor(private opts: { now: () => Date; phrase: () => string | undefined; onLocked?: (callId: string) => void }) {}

  private state(callId: string): CallState {
    const t = this.opts.now().getTime();
    for (const [id, s] of this.calls) if (t - s.touched > FORGET_AFTER_MS) this.calls.delete(id);
    let s = this.calls.get(callId);
    if (!s) this.calls.set(callId, (s = { failures: 0, locked: false, touched: t }));
    s.touched = t;
    return s;
  }

  /** Too many wrong tries: opening the garage stays refused for the rest of the call. */
  locked(callId: string): boolean {
    return this.state(callId).locked;
  }

  /** Did the person say the passphrase in `said` (anywhere in the sentence)? Three misses lock the call. */
  attempt(callId: string, said: string): PhraseResult {
    const s = this.state(callId);
    if (s.locked) return "locked";
    const phrase = normaliseWords(this.opts.phrase() ?? "");
    if (!phrase) return "no_phrase";
    if (` ${normaliseWords(said)} `.includes(` ${phrase} `)) {
      s.failures = 0;
      return "ok";
    }
    s.failures++;
    if (s.failures >= PHRASE_MAX_TRIES) {
      s.locked = true;
      this.opts.onLocked?.(callId);
      return "locked";
    }
    return "wrong";
  }
}
