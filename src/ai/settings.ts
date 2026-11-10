// Everything about WHICH model we call, and how much we allow ourselves to spend, in one place.
// To try another model or a cheap classifier later, change it here (and in llm.ts if the
// provider changes).

/** Vercel AI Gateway model id (checked against https://ai-gateway.vercel.sh/v1/models). */
export const AI_MODEL = "anthropic/claude-haiku-5.5";
export const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";

/** Used to estimate cost from token counts. USD per token (haiku-5.5: $0.10 / $0.50 per million). */
export const PRICE_PER_INPUT_TOKEN = 0.0000001;
export const PRICE_PER_OUTPUT_TOKEN = 0.0000005;

/** Hard stops. Past either one, no more LLM calls are made until the day / month rolls over. */
export const DAILY_CALL_CAP = 100;
export const MONTHLY_SPEND_CAP_USD = 10;

/** The provider name used in the api_usage table. */
export const AI_PROVIDER = "ai_gateway";
