import { z } from "zod";
import { monthKey, monthRange, startOfDay, zoned } from "../../telegram/time";
import { isTestMerchant } from "../../ui/vm/expenses";
import { defineTool } from "../registry";
import { clean } from "../sanitize";
import { listSpoken, plural, spokenMoney } from "../speak";
import type { ToolDeps } from "./deps";

interface Row {
  merchant: string | null;
  amount_cents: number;
  category: string | null;
  at: string;
}

/** The start of "today", "this week" (since Monday) or "this month" in Sydney. */
export function periodStart(period: "today" | "week" | "month", now: Date): Date {
  const z = zoned(now);
  if (period === "today") return startOfDay(z.year, z.month, z.day);
  if (period === "month") return monthRange(monthKey(now)).start;
  const weekday = new Date(Date.UTC(z.year, z.month - 1, z.day)).getUTCDay(); // 0 = Sunday
  return startOfDay(z.year, z.month, z.day - ((weekday + 6) % 7));
}

/** What I spent: from the database (not the Sheet). Test rows, duplicates and unreadable taps are left out. */
export const expensesSummary = (deps: ToolDeps) =>
  defineTool({
    name: "expenses_summary",
    description: "How much I have spent today, this week (since Monday) or this month: the total, the number of purchases, and the top three categories.",
    schema: z.object({ period: z.enum(["today", "week", "month"]) }),
    risk: "read",
    timeoutMs: 4000,
    handler: (args, ctx) => {
      const from = periodStart(args.period, ctx.now).getTime();
      const rows = (
        deps.db
          .prepare(`SELECT merchant, amount_cents, category, COALESCE(occurred_at, received_at) AS at FROM expenses WHERE sheet_status NOT IN ('duplicate', 'unparsed') AND parse_status = 'ok' AND amount_cents IS NOT NULL`)
          .all() as Row[]
      ).filter((r) => !isTestMerchant(r.merchant) && Date.parse(r.at) >= from && Date.parse(r.at) <= ctx.now.getTime());
      const label = args.period === "today" ? "today" : args.period === "week" ? "this week" : "this month";
      if (rows.length === 0) return { speech: `You haven't spent anything ${label}.`, data: { period: args.period, count: 0, total_cents: 0 } };
      const total = rows.reduce((sum, r) => sum + r.amount_cents, 0);
      const byCategory = new Map<string, number>();
      for (const r of rows) byCategory.set(r.category ?? "Uncategorised", (byCategory.get(r.category ?? "Uncategorised") ?? 0) + r.amount_cents);
      const top = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      const topSpoken = top.length > 1 ? ` Mostly ${listSpoken(top.map(([c, v]) => `${clean(c, 30)} ${spokenMoney(v)}`))}.` : "";
      return {
        speech: `${label[0].toUpperCase()}${label.slice(1)} you've spent ${spokenMoney(total)} across ${plural(rows.length, "purchase")}.${topSpoken}`,
        data: { period: args.period, count: rows.length, total_cents: total, top_categories: top.map(([category, cents]) => ({ category: clean(category, 30), cents })) },
      };
    },
  });
