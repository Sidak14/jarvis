import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";

// POST /webhook/ha/garage-open: Home Assistant says "the garage has been open for 10 minutes". Same Bearer secret as the other
// webhooks. Jarvis does not take its word for it: it looks at the garage itself (runAlerts), and the same episode rules apply,
// so a repeat of this call (or the watchdog finding the same thing) never causes a second phone call.

const sha = (s: string) => createHash("sha256").update(s).digest();

export function createHaWebhook(opts: { secret: string; onGarageOpen: () => Promise<unknown>; log?: (m: string) => void }): Hono {
  const app = new Hono();
  app.post("/garage-open", (c) => {
    const supplied = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!supplied || !timingSafeEqual(sha(supplied), sha(opts.secret))) return c.json({ error: "unauthorized" }, 401);
    // Answer at once; the check (and maybe a phone call) carries on in the background.
    opts.onGarageOpen().catch((err) => opts.log?.(`garage-open check failed: ${(err as Error).message}`));
    return c.json({ ok: true }, 202);
  });
  return app;
}
