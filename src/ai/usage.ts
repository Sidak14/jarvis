import type Database from "better-sqlite3";
import { settings } from "../settings";
import {
  AI_PROVIDER,
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
  feature?: string,
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
    settings.num("ai.daily_call_cap"),
    tokens.inputTokens,
    tokens.outputTokens,
    estimateCostUsd(tokens.inputTokens, tokens.outputTokens),
  );
  // Which feature made the call (for the dashboard's breakdown only; the caps use the totals above).
  if (feature) {
    db.prepare(
      `INSERT INTO ai_usage_by_feature (feature, date, calls, input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(feature, date) DO UPDATE SET
         calls = calls + 1,
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cost_usd = cost_usd + excluded.cost_usd`,
    ).run(feature, day(now), tokens.inputTokens, tokens.outputTokens, estimateCostUsd(tokens.inputTokens, tokens.outputTokens));
  }
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
  if (calls >= settings.num("ai.daily_call_cap")) return `daily AI call cap reached (${calls}/${settings.num("ai.daily_call_cap")})`;
  const spend = aiSpendThisMonth(db, now);
  if (spend >= settings.num("ai.monthly_cap_usd")) {
    return `monthly AI spend cap reached ($${spend.toFixed(4)} of $${settings.num("ai.monthly_cap_usd")})`;
  }
  return null;
}
