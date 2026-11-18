import type { GarageReading } from "./tools/garage";

// After Open or Close starts the door, watch it until it stops, then drop a quiet note into the live call. The note is added
// WITHOUT making the assistant speak, so it never cuts in; it mentions the result at its next natural pause.

export type Note = (callId: string, text: string) => Promise<void>;

export function watchGarage(opts: { read: () => Promise<GarageReading>; note: Note; sleep?: (ms: number) => Promise<void>; limitMs?: number; pollMs?: number }) {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const limitMs = opts.limitMs ?? 40_000;
  const pollMs = opts.pollMs ?? 1000;
  return (callId: string, want: "open" | "closed"): void => {
    void (async () => {
      const word = want === "open" ? "open" : "closed";
      const verb = want === "open" ? "open" : "close";
      let state: GarageReading["state"] = want === "open" ? "opening" : "closing";
      for (let waited = 0; waited < limitMs; waited += pollMs) {
        await sleep(pollMs);
        try {
          state = (await opts.read()).state;
        } catch {
          continue;
        }
        if (state !== "opening" && state !== "closing") break;
      }
      const text =
        state === want
          ? `NOTE: the garage door is now ${word}. Mention it briefly at your next natural pause. Do not interrupt the person.`
          : `NOTE: the garage door did not ${verb}: it shows ${state}. Tell the person plainly at your next natural pause that it didn't go through. Do not try again unless they ask. Do not interrupt.`;
      await opts.note(callId, text).catch((err) => console.error(`[voice] could not tell the call about the garage: ${(err as Error).message}`));
    })();
  };
}
