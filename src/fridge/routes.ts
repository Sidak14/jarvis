import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { config, ROOT } from "../config";
import { db } from "../db";
import { currentLocation } from "../location/store";
import { calendarAuth } from "../plans/index";
import { createCalendarClient } from "../plans/calendar";
import { checkAccess, dashboardLogin, type AccessDeps } from "./access";
import type { GarageAction } from "./garage";
import { haClient, type HaClient } from "./ha";
import { LIGHTS, lightById } from "./lights";
import { homePage } from "./page";
import { weekBusy, type DayBusy } from "./week";

// The home screen, /dashboard: the next 7 days (times busy), where people are, the lights, and the garage door.
// Made for the kitchen fridge (a Samsung Family Hub) but it works on any screen. Who may open it: see access.ts.
// Everything here is private and live: never cached, never framed, never leaks a referrer.

export interface Person {
  name: string;
  /** "Home" | "Work" | "Gym" | "Out", or null when not known yet */
  where: string | null;
}

export interface HomeDeps {
  access: AccessDeps;
  /** Without one the lights and the garage can't be read or switched (the page says so). */
  ha: HaClient | null;
  people: () => Person[];
  /** The next 7 days of busy times, or an error message for the page. */
  week: () => Promise<DayBusy[]>;
  publicDir?: string;
}

const ASSETS: Record<string, string> = {
  "fridge.css": "text/css; charset=utf-8",
  "fridge.js": "text/javascript; charset=utf-8",
};

export function createHomeApp(deps: HomeDeps): Hono {
  const app = new Hono();
  const publicDir = deps.publicDir ?? path.join(ROOT, "public");

  app.use("*", dashboardLogin(deps.access));
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  });

  // The page's own requests carry this header; a form on another site can't add it, which closes cross-site posts.
  const fromOurPage = (c: Context): boolean => c.req.header("x-fridge") === "1";

  app.get("/", (c) => c.html(homePage()));

  app.get("/assets/:file", (c) => {
    const name = c.req.param("file");
    const type = ASSETS[name];
    const file = path.join(publicDir, name);
    if (!type || !fs.existsSync(file)) return c.text("Not found", 404);
    c.header("Content-Type", type);
    c.header("Cache-Control", "private, max-age=300"); // the page links ?v=<version>, so a change is picked up
    return c.body(fs.readFileSync(file, "utf8"));
  });

  // Lights, garage and people: polled every few seconds.
  app.get("/api/state", async (c) => {
    const people = deps.people();
    if (!deps.ha) return c.json({ people, error: "Home Assistant isn't set up" });
    const ha = deps.ha;
    const [lights, garage] = await Promise.all([
      ha.states(LIGHTS.map((l) => l.entity)).then((s) => LIGHTS.map((l) => ({ id: l.id, name: l.name, icon: l.icon, state: s[l.entity] ?? "unavailable" }))).catch(() => null),
      ha.garage().catch(() => null),
    ]);
    return c.json({ people, lights, garage, error: lights === null && garage === null ? "Home Assistant isn't answering" : undefined });
  });

  // Busy times: from Google Calendar, so slower and changes rarely.
  app.get("/api/week", async (c) => {
    try {
      return c.json({ days: await deps.week() });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  // The body says on or off (not "toggle"), so a double tap can't flip it twice.
  app.post("/api/lights/:id", async (c) => {
    if (!fromOurPage(c)) return c.json({ error: "bad request" }, 403);
    const light = lightById(c.req.param("id"));
    if (!light) return c.json({ error: "unknown light" }, 404);
    const body = (await c.req.json().catch(() => null)) as { on?: unknown } | null;
    if (typeof body?.on !== "boolean") return c.json({ error: "bad request" }, 400);
    if (!deps.ha) return c.json({ error: "Home Assistant isn't set up" }, 503);
    try {
      await deps.ha.setSwitch(light.entity, body.on);
    } catch (err) {
      console.error(`[home] could not switch ${light.id}:`, (err as Error).message);
      return c.json({ error: "Home Assistant isn't answering" }, 502);
    }
    console.log(`[home] ${light.name} -> ${body.on ? "on" : "off"} (${checkAccess(c, deps.access).verdict})`);
    return c.json({ ok: true });
  });

  app.post("/api/garage", async (c) => {
    if (!fromOurPage(c)) return c.json({ error: "bad request" }, 403);
    const body = (await c.req.json().catch(() => null)) as { action?: unknown } | null;
    if (body?.action !== "open" && body?.action !== "close") return c.json({ error: "bad request" }, 400);
    if (!deps.ha) return c.json({ error: "Home Assistant isn't set up" }, 503);
    try {
      await deps.ha.pressGarage(body.action as GarageAction);
    } catch (err) {
      console.error("[home] could not press the garage:", (err as Error).message);
      return c.json({ error: "Home Assistant isn't answering" }, 502);
    }
    const who = checkAccess(c, deps.access);
    console.log(`[home] garage ${body.action} (${who.verdict}${who.email ? ` ${who.email}` : ""})`);
    return c.json({ ok: true });
  });

  return app;
}

// ---- the real one
const WEEK_CACHE_MS = 5 * 60_000;
let weekCache: { at: number; days: DayBusy[] } | null = null;

export const homeRoutes = createHomeApp({
  access: {
    localHosts: [`127.0.0.1:${config.PORT}`, `localhost:${config.PORT}`],
    publicHost: config.PUBLIC_HOST,
    emails: config.DASHBOARD_EMAILS,
    log: (m) => console.log(`[home] ${m}`),
  },
  ha: config.HA_TOKEN ? haClient(config.HA_URL, config.HA_TOKEN) : null,
  people: () => {
    const now = currentLocation(db);
    return [{ name: "Gurveer", where: now ? (now.place === "Other" ? "Out" : now.place) : null }];
  },
  async week() {
    if (weekCache && Date.now() - weekCache.at < WEEK_CACHE_MS) return weekCache.days;
    if (!calendarAuth.isConnected()) throw new Error("Google Calendar isn't connected");
    const now = new Date();
    const end = new Date(now.getTime() + 8 * 86_400_000);
    const spans = await createCalendarClient(calendarAuth).overlapping(new Date(now.getTime() - 86_400_000).toISOString(), end.toISOString());
    weekCache = { at: Date.now(), days: weekBusy(spans, now) };
    return weekCache.days;
  },
});
