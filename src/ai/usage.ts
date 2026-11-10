import type Database from "better-sqlite3";
import {
  AI_PROVIDER,
  DAILY_CALL_CAP,
  MONTHLY_SPEND_CAP_USD,
  PRICE_PER_INPUT_TOKEN,
  PRICE_PER_OUTPUT_TOKEN,
} from "./settings";

const day = (now: Date) => now.toISOString().slice(0, 10); // UTC date, like the other providers

export const estimateCostUsd = (inputTokens: number, outputTokens: number) =>
  inputTokens * PRICE_PER_INPUT_TOKEN + outputTokens * PRICE_PER_OUTPUT_TOKEN;

/** Log one LLM call in api_usage: a call, its tokens and its estimated cost. */
export function recordAiCall(
  db: Database.Database,
  tokens: { inputTokens: number; outputTokens: number },
  now = new Date(),
): void {
  db.prepare(
    `INSERT INTO api_usage (provider, date, units_used, limit_units, input_tokens, output_tokens, cost_usd)
     VALUES (?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(provider, date) DO UPDATE SET
       units_used = units_used + 1,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cost_usd = cost_usd + excluded.cost_usd`,
  ).run(
    AI_PROVIDER,
    day(now),
    DAILY_CALL_CAP,
    tokens.inputTokens,
    tokens.outputTokens,
    estimateCostUsd(tokens.inputTokens, tokens.outputTokens),
  );
}

export function aiCallsToday(db: Database.Database, now = new Date()): number {
  const row = db
    .prepare(`SELECT units_used AS n FROM api_usage WHERE provider = ? AND date = ?`)
    .get(AI_PROVIDER, day(now)) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Estimated spend since the 1st of this (UTC) month. */
export function aiSpendThisMonth(db: Database.Database, now = new Date()): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM api_usage WHERE provider = ? AND date >= ?`)
    .get(AI_PROVIDER, `${day(now).slice(0, 7)}-01`) as { usd: number };
  return row.usd;
}

/** Why no more LLM calls are allowed right now, or null if we are under both caps. */
export function aiCapReason(db: Database.Database, now = new Date()): string | null {
  const calls = aiCallsToday(db, now);
  if (calls >= DAILY_CALL_CAP) return `daily AI call cap reached (${calls}/${DAILY_CALL_CAP})`;
  const spend = aiSpendThisMonth(db, now);
  if (spend >= MONTHLY_SPEND_CAP_USD) {
    return `monthly AI spend cap reached ($${spend.toFixed(4)} of $${MONTHLY_SPEND_CAP_USD})`;
  }
  return null;
}
