import { z } from "zod";
import { dayKey, startOfDay, zoned } from "../../telegram/time";
import { defineTool } from "../registry";
import { clean, quoted } from "../sanitize";
import { listSpoken, spokenTime, words } from "../speak";
import type { ToolDeps } from "./deps";

/** What is on my main calendar for the rest of today and tomorrow morning. */
export const calendarToday = (deps: ToolDeps) =>
  defineTool({
    name: "calendar_today",
    description: "What is on my calendar for the rest of today and tomorrow morning.",
    schema: z.object({}),
    risk: "read",
    timeoutMs: 7000,
    handler: async (_args, ctx) => {
      const calendar = deps.calendar();
      if (!calendar) return { speech: "My calendar isn't connected right now.", data: { available: false } };
      const z0 = zoned(ctx.now);
      const midnight = startOfDay(z0.year, z0.month, z0.day);
      const tomorrow = startOfDay(z0.year, z0.month, z0.day + 1);
      const noonTomorrow = new Date(tomorrow.getTime() + 12 * 3_600_000);
      const events = await calendar.agenda(midnight.toISOString(), noonTomorrow.toISOString());
      const today = dayKey(ctx.now);
      const line = (e: (typeof events)[number]) => `${e.allDay ? "all day" : spokenTime(new Date(e.startIso))} ${quoted(e.summary)}`;
      const rest = events.filter((e) => dayKey(new Date(e.startIso)) === today && (e.allDay || new Date(e.endIso) > ctx.now));
      const morning = events.filter((e) => dayKey(new Date(e.startIso)) !== today && !e.allDay && new Date(e.startIso) < noonTomorrow);
      const parts = [
        rest.length ? `Today: ${listSpoken(rest.map(line))}.` : "Nothing else on today.",
        morning.length ? `Tomorrow morning: ${listSpoken(morning.map(line))}.` : "Tomorrow morning is clear.",
      ];
      const more = rest.length + morning.length > 3 ? " Want the rest?" : "";
      return {
        speech: `${parts.join(" ")}${more}`,
        data: {
          today_remaining: rest.map((e) => ({ time: e.allDay ? "all day" : spokenTime(new Date(e.startIso)), title: clean(e.summary) })),
          tomorrow_morning: morning.map((e) => ({ time: spokenTime(new Date(e.startIso)), title: clean(e.summary) })),
          count: words(rest.length + morning.length),
        },
      };
    },
  });
