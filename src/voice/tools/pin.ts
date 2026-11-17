import { z } from "zod";
import { defineTool } from "../registry";

/** Checks the spoken PIN in code (the model never sees the answer to "is it right?" beyond the outcome). */
export const verifyPin = defineTool({
  name: "verify_pin",
  description: "Check the PIN the person has just said. Pass only the digits they said. Never repeat the PIN back and never ask for it unless a tool asks for it.",
  schema: z.object({ pin: z.string().min(1).max(40) }),
  risk: "read",
  timeoutMs: 3000,
  handler: (args, ctx) => {
    switch (ctx.security.attempt(ctx.callId, args.pin)) {
      case "ok":
        return { speech: "Thanks, that's right.", data: { pin_ok: true, valid_for_minutes: 10 } };
      case "wrong":
        return { speech: "That wasn't right.", data: { pin_ok: false } };
      case "locked":
        return { speech: "Too many wrong tries. I can't unlock anything on this call.", data: { pin_ok: false, locked: true } };
      case "no_pin":
        return { speech: "No PIN has been set up, so I can't unlock that.", data: { pin_ok: false } };
    }
  },
});
