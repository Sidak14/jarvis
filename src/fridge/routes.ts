import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config, ROOT } from "../config";
import { createAuth, SESSION_IDLE_MS, type FridgeAuth } from "./auth";
import { haClient, type HaClient } from "./ha";
import { LIGHTS, lightById } from "./lights";
import { fridgePage } from "./page";

// The kitchen fridge screen: /fridge. Unlike the dashboards it is NOT behind dashboardAccess (the fridge can't log in
// to Cloudflare Access), so it protects itself: the code is checked on the server (auth.ts) and only a live session
// can read or switch the lights in lights.ts. Only requests addressed to this Mac or to our own hostname are served.

const COOKIE = "fridge";

export interface FridgeDeps {
  /** The unlock code. Without one the whole page is off (404). */
  code: string | undefined;
  /** Without one the lights can't be read or switched (the page says so). */
  ha: HaClient | null;
  /** Host headers we answer to: this Mac and the public hostname. Anything else is refused. */
  hosts: string[];
  now?: () => number;
  publicDir?: string;
}

const ASSETS: Record<string, string> = {
  "dashboard.css": "text/css; charset=utf-8",
  "fridge.css": "text/css; charset=utf-8",
  "fridge.js": "text/javascript; charset=utf-8",
};

export function createFridgeApp(deps: FridgeDeps): Hono {
  const app = new Hono();
  const auth: FridgeAuth | null = deps.code ? createAuth({ code: deps.code, now: deps.now }) : null;
  const publicDir = deps.publicDir ?? path.join(ROOT, "public");

  // Everything here is private and live: never cached, never framed, never leaks a referrer.
  app.use("*", async (c, next) => {
    if (!deps.hosts.includes(c.req.header("host") ?? "")) return c.text("Forbidden", 403);
    if (!auth) return c.text("Not found", 404);
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  });

  const client = (c: Context): string => c.req.header("cf-connecting-ip") ?? "local";
  const isHttps = (c: Context): boolean => c.req.header("x-forwarded-proto") === "https";
  // The page's own requests carry this header; a form on another site can't add it, which closes cross-site posts.
  const fromOurPage = (c: Context): boolean => c.req.header("x-fridge") === "1";
  const live = (c: Context): boolean => auth!.check(getCookie(c, COOKIE));

  function setSession(c: Context, token: string): void {
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Strict", path: "/fridge", secure: isHttps(c), maxAge: Math.floor(SESSION_IDLE_MS / 1000) });
  }

  app.get("/", (c) => c.html(fridgePage({ idleMs: SESSION_IDLE_MS })));

  // Only these three files, read from /public (the page links them; the CSS is the dashboard's own, so it matches).
  app.get("/assets/:file", (c) => {
    const name = c.req.param("file");
    const type = ASSETS[name];
    const file = path.join(publicDir, name);
    if (!type || !fs.existsSync(file)) return c.text("Not found", 404);
    c.header("Content-Type", type);
    c.header("Cache-Control", "private, max-age=300"); // the page links ?v=<version>, so a change is picked up
    return c.body(fs.readFileSync(file, "utf8"));
  });

  app.post("/unlock", async (c) => {
    if (!fromOurPage(c)) return c.json({ ok: false }, 403);
    const body = (await c.req.json().catch(() => null)) as { keys?: unknown } | null;
    const result = auth!.attempt(client(c), typeof body?.keys === "string" ? body.keys : "");
    if (result.ok) {
      setSession(c, result.token);
      return c.json({ ok: true });
    }
    if (result.retryAfterSec) return c.json({ ok: false, retryAfterSec: result.retryAfterSec }, 429);
    return c.json({ ok: false }, 401);
  });

  app.post("/lock", (c) => {
    if (!fromOurPage(c)) return c.json({ ok: false }, 403);
    auth!.revoke(getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: "/fridge" });
    return c.json({ ok: true });
  });

  // Lets the page ask "am I already unlocked?" (after a refresh) without an error response.
  app.get("/api/session", (c) => c.json({ unlocked: live(c) }));

  app.get("/api/lights", async (c) => {
    if (!live(c)) return c.json({ error: "locked" }, 401);
    if (!deps.ha) return c.json({ error: "Home Assistant isn't set up" }, 503);
    try {
      const states = await deps.ha.states(LIGHTS.map((l) => l.entity));
      return c.json({ lights: LIGHTS.map((l) => ({ id: l.id, name: l.name, icon: l.icon, state: states[l.entity] ?? "unavailable" })) });
    } catch {
      return c.json({ error: "Home Assistant isn't answering" }, 502);
    }
  });

  // The body says on or off (not "toggle"), so a double tap can't flip it twice.
  app.post("/api/lights/:id", async (c) => {
    if (!fromOurPage(c)) return c.json({ error: "bad request" }, 403);
    if (!live(c)) return c.json({ error: "locked" }, 401);
    const light = lightById(c.req.param("id"));
    if (!light) return c.json({ error: "unknown light" }, 404);
    const body = (await c.req.json().catch(() => null)) as { on?: unknown } | null;
    if (typeof body?.on !== "boolean") return c.json({ error: "bad request" }, 400);
    if (!deps.ha) return c.json({ error: "Home Assistant isn't set up" }, 503);
    try {
      await deps.ha.setSwitch(light.entity, body.on);
    } catch (err) {
      console.error(`[fridge] could not switch ${light.id}:`, (err as Error).message);
      return c.json({ error: "Home Assistant isn't answering" }, 502);
    }
    console.log(`[fridge] ${light.name} -> ${body.on ? "on" : "off"}`);
    return c.json({ ok: true });
  });

  return app;
}

export const fridgeRoutes = createFridgeApp({
  code: config.FRIDGE_CODE,
  ha: config.HA_TOKEN ? haClient(config.HA_URL, config.HA_TOKEN) : null,
  hosts: [`127.0.0.1:${config.PORT}`, `localhost:${config.PORT}`, config.PUBLIC_HOST],
});
