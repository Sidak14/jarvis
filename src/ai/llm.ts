import type Database from "better-sqlite3";
import { AI_MODEL, GATEWAY_URL } from "./settings";
import { aiCapReason, recordAiCall } from "./usage";

/** The only thing the rest of Jarvis knows about the LLM: text in, text out. */
export interface Llm {
  /** `maxTokens` limits the length of the reply (default 500; plan detection asks for more). */
  complete(system: string, user: string, options?: { maxTokens?: number }): Promise<string>;
}

/** The call was not made because a spend/call cap is reached. */
export class AiCapError extends Error {}
/** The gateway call failed (network, auth, rate limit, bad reply). Retrying later may work. */
export class LlmError extends Error {}

export function createGatewayLlm(opts: {
  apiKey: string;
  db: Database.Database;
  fetchFn?: typeof fetch;
  /** A label for the dashboard's spend breakdown ("invoices", "plans", ...). Changes nothing else. */
  feature?: string;
}): Llm {
  const { apiKey, db, fetchFn = fetch, feature } = opts;
  return {
    async complete(system, user, options) {
      // The caps are enforced here, in the one place every call goes through.
      const capReason = aiCapReason(db);
      if (capReason) throw new AiCapError(capReason);

      const tokens = { inputTokens: 0, outputTokens: 0 };
      try {
        let res: Response;
        try {
          res = await fetchFn(GATEWAY_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: AI_MODEL,
              max_tokens: options?.maxTokens ?? 500,
              messages: [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
            }),
            signal: AbortSignal.timeout(30_000),
          });
        } catch (err) {
          throw new LlmError(`AI Gateway request failed (${(err as Error).name})`);
        }
        const json = (await res.json().catch(() => ({}))) as {
          choices?: { message?: { content?: unknown } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          error?: { message?: string };
        };
        tokens.inputTokens = json.usage?.prompt_tokens ?? 0;
        tokens.outputTokens = json.usage?.completion_tokens ?? 0;
        if (!res.ok) {
          throw new LlmError(`AI Gateway HTTP ${res.status}: ${String(json.error?.message ?? "").slice(0, 150)}`);
        }
        const text = json.choices?.[0]?.message?.content;
        if (typeof text !== "string") throw new LlmError("AI Gateway reply had no text");
        return text;
      } finally {
        // Every attempt counts toward the caps, even a failed one, so a loop cannot run up a bill.
        recordAiCall(db, tokens, new Date(), feature);
      }
    },
  };
}
