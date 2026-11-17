import { z } from "zod";
import { defineTool } from "../registry";
import { TIMEZONE } from "../settings";

/** Proves the loop works: the time in Sydney. */
export const ping = defineTool({
  name: "ping",
  description: "Get the current date and time in Sydney. Use it when asked what time or day it is.",
  schema: z.object({}),
  risk: "read",
  timeoutMs: 2000,
  handler: (_args, ctx) => {
    const time = new Intl.DateTimeFormat("en-AU", { timeZone: TIMEZONE, hour: "numeric", minute: "2-digit", hour12: true }).format(ctx.now);
    const day = new Intl.DateTimeFormat("en-AU", { timeZone: TIMEZONE, weekday: "long", day: "numeric", month: "long" }).format(ctx.now);
    return { speech: `It's ${time} on ${day}.`, data: { time, day, timezone: TIMEZONE } };
  },
});
