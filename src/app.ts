import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { config } from "./config";
import { db } from "./db";
import { fridgeRoutes } from "./fridge/routes";
import { gmailRoutes } from "./gmail/routes";
import { calendarRoutes, plansRoutes } from "./plans/routes";
import { triggerJob } from "./runner";
import { spotifyRoutes } from "./spotify/routes";
import { uiRoutes } from "./ui/routes";
import { getWebhook } from "./webhooks";

const sha256 = (s: string) => createHash("sha256").update(s).digest();
const secretHash = sha256(config.WEBHOOK_SECRET);

/** Constant-time check of "Authorization: Bearer <secret>". */
function isAuthorized(header: string | undefined): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  const supplied = sha256(match ? match[1] : "");
  // Hashing first makes both buffers the same length, so timingSafeEqual is safe
  // and the secret's length isn't leaked through timing.
  const ok = timingSafeEqual(supplied, secretHash);
  return ok && match !== null;
}

export const app = new Hono();

// Minimal request log: method, path, status. Never headers, bodies or config.
app.use("*", async (c, next) => {
  await next();
  console.log(`[http] ${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status}`);
});

app.get("/health", (c) => c.json({ ok: true }));

// Spotify dashboard, login and manual run. Local-only (see spotify/routes.ts).
app.route("/spotify", spotifyRoutes);
app.route("/gmail", gmailRoutes);
app.route("/plans", plansRoutes);
app.route("/calendar", calendarRoutes);
// The kitchen fridge screen. Public (the fridge can't log in), so it guards itself with a code (see fridge/routes.ts).
app.route("/fridge", fridgeRoutes);
// Overview (/), /expenses, /jobs and the two dashboard asset files (src/ui/routes.ts).
app.route("/", uiRoutes);

const MAX_BODY_BYTES = 64 * 1024;

app.post("/webhook/:name", async (c) => {
  if (!isAuthorized(c.req.header("Authorization"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const name = c.req.param("name");

  // A webhook that wants the request body (e.g. expenses) takes precedence over a job of the same name.
  const hook = getWebhook(name);
  if (hook) {
    const text = await c.req.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) return c.json({ error: "body too large" }, 413);
    // Not valid JSON is the handler's call: it may still want to keep the request.
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    try {
      const result = await hook({ body, rawText: text, log: (m) => console.log(`[webhook:${name}] ${m}`) });
      return c.json(result.body, result.status);
    } catch (err) {
      console.error(`[webhook:${name}] failed:`, (err as Error).message);
      return c.json({ error: "internal error" }, 500);
    }
  }

  if (!triggerJob(name)) return c.json({ error: "unknown job" }, 404);
  return c.json({ ok: true, triggered: name }, 202);
});
