import { z } from "zod";
import { dayKey } from "../../telegram/time";
import { allPlans, type Plan } from "../../plans/store";
import { defineTool } from "../registry";
import { quoted } from "../sanitize";
import { plural, words } from "../speak";
import type { ToolDeps } from "./deps";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function when(p: Plan, today: string): string {
  if (!p.date) return "no day yet";
  const [y, m, d] = p.date.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  const diff = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
  const day = diff === 0 ? "today" : diff === 1 ? "tomorrow" : WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  if (!p.start_time) return day;
  const [h, min] = p.start_time.split(":").map(Number);
  return `${day} at ${h % 12 === 0 ? 12 : h % 12}${min ? `:${String(min).padStart(2, "0")}` : ""}${h >= 12 ? "pm" : "am"}`;
}

const stanceWords: Record<Plan["my_stance"], string> = { committed: "you're going", declined: "you said no", unsure: "you said maybe", none: "you haven't replied" };

/** Plans in the next 7 days, with my stance and status, and any calendar clash. */
export const plansUpcoming = (deps: ToolDeps) =>
  defineTool({
    name: "plans_upcoming",
    description: "My plans over the next seven days: what, when, whether I'm going, whether it's confirmed, and whether it clashes with my calendar.",
    schema: z.object({}),
    risk: "read",
    timeoutMs: 4000,
    handler: (_args, ctx) => {
      const today = dayKey(ctx.now);
      const end = dayKey(new Date(ctx.now.getTime() + 7 * 86_400_000));
      const plans = allPlans(deps.db)
        .filter((p) => !p.archived_at && p.plan_status !== "cancelled" && p.my_stance !== "declined" && p.date !== null && p.date >= today && p.date <= end)
        .sort((a, b) => `${a.date} ${a.start_time ?? ""}`.localeCompare(`${b.date} ${b.start_time ?? ""}`));
      if (plans.length === 0) return { speech: "You have no plans in the next seven days.", data: { count: 0 } };
      const line = (p: Plan) =>
        `${quoted(p.title, 50)} ${when(p, today)}, ${stanceWords[p.my_stance]}, ${p.plan_status}${p.cal_state === "clash" ? ", clashing with your calendar" : ""}`;
      const said = plans.slice(0, 3).map(line);
      return {
        speech: `You have ${plural(plans.length, "plan")} this week. ${said.map((l, i) => (i === 0 ? `${l}.` : ` Then ${l}.`)).join("")}${plans.length > 3 ? ` And ${words(plans.length - 3)} more. Want them?` : ""}`,
        data: {
          plans: plans.map((p) => ({ title: p.title, when: when(p, today), my_stance: p.my_stance, status: p.plan_status, clash: p.cal_state === "clash", chat: p.source_chat_name })),
        },
      };
    },
  });
