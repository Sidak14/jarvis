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
            // With a first message, "waits for user" means: wait, then play THAT message ("Jarvis here, how can I help?"). Empty,
            // the model answers instead, and its prompt (the alert variable below) says who it is and why it called.
            firstMessage: "",
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

/**
 * Adds a note to a call that is going on, without making the assistant speak (so it never interrupts). Vapi gives every live
 * call a control URL; it is looked up with the call id. The assistant sees the note and mentions it at its next turn.
 */
export function vapiNotes(opts: { apiKey: string; fetchFn?: typeof fetch }) {
  const fetchFn = opts.fetchFn ?? fetch;
  const headers = { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" };
  return async (callId: string, text: string): Promise<void> => {
    const res = await fetchFn(`${API}/call/${encodeURIComponent(callId)}`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Vapi answered ${res.status} for the call`);
    const url = ((await res.json()) as { monitor?: { controlUrl?: unknown } }).monitor?.controlUrl;
    if (typeof url !== "string" || !url.startsWith("https://")) throw new Error("the call has no control URL");
    const sent = await fetchFn(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "add-message", message: { role: "system", content: text }, triggerResponseEnabled: false }), signal: AbortSignal.timeout(8000) });
    if (!sent.ok) throw new Error(`Vapi answered ${sent.status} to the note`);
  };
}
