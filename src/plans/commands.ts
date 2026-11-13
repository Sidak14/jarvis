import type Database from "better-sqlite3";
import { oneLine } from "../telegram/format";
import { createEventNow, eventTimes, ownerStance, removeEventNow, whenLabel, type ActionDeps } from "./actions";
import { allPlans, getPlan, parsePlanCode, planCode, type Plan } from "./store";

// The Telegram commands for plans. Each one is a fixed word plus a plan code like P-0003: nothing
// typed is ever run. There are no buttons (Beeper does not show them), so Undo, Add back and the
// rest are commands.

export const PLAN_COMMANDS = ["/undo", "/addback", "/addanyway", "/keep", "/remove", "/plans"] as const;
export const PLAN_HELP = `/plans - upcoming plans and what needs you
/undo P-0001 - remove an event Jarvis added
/addback P-0001 - put a plan back on the calendar
/addanyway P-0001 - add a plan even though it clashes
/keep P-0001 or /remove P-0001 - after you said maybe`;

export function isPlanCommand(word: string): boolean {
  return (PLAN_COMMANDS as readonly string[]).includes(word);
}

const line = (p: Plan) => `${planCode(p.id)} ${oneLine(p.title, 40)}, ${whenLabel(p)} [${p.plan_status}, ${p.my_stance === "none" ? "no reply" : p.my_stance}]`;

export function plansText(db: Database.Database, dryRun: boolean): string {
  const open = allPlans(db).filter((p) => p.plan_status !== "cancelled");
  if (open.length === 0) return "No plans yet.";
  const upcoming = open.filter((p) => p.my_stance === "committed").sort((a, b) => (a.date ?? "9").localeCompare(b.date ?? "9"));
  const waiting = open.filter((p) => p.my_stance !== "committed" && p.my_stance !== "declined");
  return [
    dryRun ? "(dry run: the calendar is not touched)" : "",
    upcoming.length ? "Going to:" : "",
    ...upcoming.slice(0, 8).map(line),
    waiting.length ? "Waiting on you / unconfirmed:" : "",
    ...waiting.slice(0, 8).map(line),
  ].filter(Boolean).join("\n");
}

/** Returns the reply, or null if `word` is not a plan command. */
export async function runPlanCommand(deps: ActionDeps, word: string, arg: string): Promise<string | null> {
  if (!isPlanCommand(word)) return null;
  if (word === "/plans") return plansText(deps.db, deps.dryRun);
  const id = parsePlanCode(arg.split(/\s+/)[0] ?? "");
  const plan = id === null ? undefined : getPlan(deps.db, id);
  if (!plan) return `Which plan? Use the code from my message, for example ${word} P-0001`;
  const pid = planCode(plan.id);
  const now = deps.now;

  if (deps.dryRun) return "Dry run is on: I have not touched your calendar, so there is nothing to change. (PLANS_DRY_RUN=false turns it on.)";
  if (!deps.calendar) return "Google Calendar is not connected. Log in at /calendar/login first.";

  switch (word) {
    case "/undo": {
      if (!plan.event_id) return `${pid} is not on your calendar.`;
      await removeEventNow(deps, plan, "undo");
      return `Removed ${oneLine(plan.title, 60)} from your calendar. Reply /addback ${pid} to add it again.`;
    }
    case "/remove": {
      if (!plan.event_id) return `${pid} is not on your calendar.`;
      await removeEventNow(deps, plan, "remove");
      ownerStance(deps.db, plan.id, "declined", now);
      return `Removed ${oneLine(plan.title, 60)} from your calendar and marked you as not going.`;
    }
    case "/keep": {
      ownerStance(deps.db, plan.id, "committed", now);
      return `Kept ${oneLine(plan.title, 60)} on your calendar.`;
    }
    case "/addback":
    case "/addanyway": {
      if (plan.plan_status === "cancelled") return `${pid} was cancelled.`;
      if (!eventTimes(plan)) return `${pid} has no exact day and time yet, so I can't add it.`;
      if (plan.event_id) return `${pid} is already on your calendar.`;
      if (word === "/addback") ownerStance(deps.db, plan.id, "committed", now);
      const fresh = getPlan(deps.db, plan.id)!;
      // You asked for it: skip the clash check and the confirmed / confidence conditions.
      const outcome = await createEventNow(deps, { ...fresh, my_stance: "committed" }, { force: true });
      if (outcome === "created") return ""; // createEventNow already told you ("Added ...")
      if (outcome === "capped") return "";
      return `Could not add it (${outcome}).`;
    }
  }
  return null;
}
