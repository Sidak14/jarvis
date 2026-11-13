import type Database from "better-sqlite3";
import { DAILY_CALL_CAP, MONTHLY_SPEND_CAP_USD } from "../../ai/settings";
import { aiCallsToday, aiSpendThisMonth } from "../../ai/usage";

// AI spend for the whole server: the real total (every feature shares one cap) plus a per-feature breakdown.

export const FEATURE_LABELS: Record<string, string> = { invoices: "Invoices", plans: "Plans", categorising: "Categorising", log: "/log" };

export interface AiUsageVM {
  spendUsd: number;
  capUsd: number;
  fraction: number;
  callsToday: number;
  callCap: number;
  byFeature: { feature: string; label: string; calls: number; costUsd: number }[];
  /** Spend from before calls were tagged (or untagged calls). Shown so the breakdown always adds up to the total. */
  untaggedUsd: number;
}

export function buildAiUsage(db: Database.Database, now: Date): AiUsageVM {
  const spendUsd = aiSpendThisMonth(db, now);
  const monthStart = `${now.toISOString().slice(0, 7)}-01`;
  const rows = db
    .prepare(`SELECT feature, SUM(calls) AS calls, SUM(cost_usd) AS cost FROM ai_usage_by_feature WHERE date >= ? GROUP BY feature ORDER BY cost DESC`)
    .all(monthStart) as { feature: string; calls: number; cost: number }[];
  const byFeature = rows.map((r) => ({ feature: r.feature, label: FEATURE_LABELS[r.feature] ?? r.feature, calls: r.calls, costUsd: r.cost }));
  const tagged = byFeature.reduce((sum, f) => sum + f.costUsd, 0);
  return {
    spendUsd,
    capUsd: MONTHLY_SPEND_CAP_USD,
    fraction: MONTHLY_SPEND_CAP_USD ? spendUsd / MONTHLY_SPEND_CAP_USD : 0,
    callsToday: aiCallsToday(db, now),
    callCap: DAILY_CALL_CAP,
    byFeature,
    untaggedUsd: Math.max(0, spendUsd - tagged),
  };
}
