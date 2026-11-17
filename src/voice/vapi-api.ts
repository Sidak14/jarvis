// Vapi's REST API as Jarvis uses it at run time: place a call. (Setting up the assistant is push.ts.)

const API = "https://api.vapi.ai";

export interface CallPlacer {
  /** Phone `number`; the assistant waits for the person to speak, then says `alert`. Resolves to Vapi's call id. */
  placeAlertCall(opts: { number: string; alert: string }): Promise<string>;
}

export function vapiCalls(opts: { apiKey: string; phoneNumberId: string; assistantId: () => string | null; maxSeconds?: number; fetchFn?: typeof fetch }): CallPlacer {
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    async placeAlertCall({ number, alert }) {
      const assistantId = opts.assistantId();
      if (!assistantId) throw new Error("the assistant has not been pushed to Vapi yet (npm run voice:push)");
      const res = await fetchFn(`${API}/call`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          assistantId,
          phoneNumberId: opts.phoneNumberId,
          customer: { number },
          assistantOverrides: {
            // Stay silent until a PERSON speaks, so a voicemail greeting is never played the details. The assistant says the
            // alert (a prompt variable) only once somebody has answered; voicemail detection hangs up without a message.
            firstMessageMode: "assistant-waits-for-user",
            variableValues: { alert },
            maxDurationSeconds: opts.maxSeconds ?? 180,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Vapi answered ${res.status}: ${text.slice(0, 200)}`);
      const id = (JSON.parse(text) as { id?: unknown }).id;
      if (typeof id !== "string") throw new Error("Vapi's answer had no call id");
      return id;
    },
  };
}
