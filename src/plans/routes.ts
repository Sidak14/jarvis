import { randomBytes } from "node:crypto";
import { appendToPage, flashFrom, SettingsPanel } from "../ui/settings";
import { Hono, type Context } from "hono";
import { dashboardAccess } from "../access";
import { esc, layout } from "../html";
import { liveContext } from "../ui/context";
import { plansPage } from "../ui/pages/plans";
import { buildPlans } from "../ui/vm/plans";
import { calendarAuth } from "./index";
import { config } from "../config";
import { db } from "../db";
import { sameSite } from "../ui/settings";
import { deletePlace, editPlace, getPlace, listPlaces, verifyPlace } from "./places";

export const calendarRoutes = new Hono();
export const plansRoutes = new Hono();

// ---- Google Calendar login (same access rules and shape as /gmail/login)
const pendingStates = new Map<string, number>(); // login state -> expiry (ms)
const STATE_TTL_MS = 10 * 60 * 1000;
const notice = (title: string, message: string, isError = false) =>
  layout(title, `<h1>${esc(title)}</h1><p class="${isError ? "error" : ""}">${esc(message)}</p><p><a href="/plans">Back to plans</a></p>`);

calendarRoutes.get("/login", dashboardAccess, (c) => {
  if (!calendarAuth.isConfigured()) {
    return c.html(notice("Calendar is not configured", "Add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET to .env and restart Jarvis.", true), 400);
  }
  const state = randomBytes(16).toString("hex");
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  return c.redirect(calendarAuth.authorizeUrl(state));
});

calendarRoutes.get("/callback", dashboardAccess, async (c) => {
  const state = c.req.query("state") ?? "";
  const expiry = pendingStates.get(state);
  pendingStates.delete(state); // each state works once
  if (!expiry || expiry < Date.now()) return c.html(notice("Login failed", "Unknown or expired login attempt. Start again from /calendar/login.", true), 400);
  const googleError = c.req.query("error");
  if (googleError) return c.html(notice("Login cancelled", `Google said: ${googleError}`, true), 400);
  const code = c.req.query("code");
  if (!code) return c.html(notice("Login failed", "Google did not send a code.", true), 400);
  try {
    await calendarAuth.exchangeCode(code);
  } catch (err) {
    return c.html(notice("Login failed", (err as Error).message, true), 502);
  }
  return c.html(notice("Calendar connected", "Login saved. Jarvis will refresh it automatically."));
});

// ---- /plans: read-only (the page is built in src/ui: view-model + template)
plansRoutes.get("/", dashboardAccess, (c) => {
  const ctx = liveContext();
  const q = c.req.query();
  return c.html(appendToPage(plansPage(buildPlans(ctx), ctx.now, { ok: q.place_ok, err: q.place_err }), SettingsPanel({ group: "plans", back: "/plans", flash: flashFrom(c.req.query()) })));
});

// ---- Saved places: edit, delete, look up on Google Maps (plain form posts from the Plans page)
const sameSiteOnly = (c: Context) => sameSite({ origin: c.req.header("origin"), host: c.req.header("host"), secFetchSite: c.req.header("sec-fetch-site") });
const back = (c: Context, kind: "ok" | "err", text: string) => c.redirect(`/plans?place_${kind}=${encodeURIComponent(text.slice(0, 300))}#places`, 303);

plansRoutes.post("/places/:id/save", dashboardAccess, async (c) => {
  if (!sameSiteOnly(c)) return c.text("Forbidden", 403);
  const id = Number(c.req.param("id"));
  const form = new URLSearchParams(await c.req.text());
  const problem = editPlace(db, id, form.get("name") ?? "", form.get("address") ?? "");
  if (problem) return back(c, "err", `Not saved: ${problem}.`);
  const place = getPlace(db, id)!;
  if (!place.address) return back(c, "ok", `Saved ${place.name}.`);
  if (place.verified) return back(c, "ok", `Saved ${place.name}.`);
  const found = await verifyPlace(db, id, config.GOOGLE_MAPS_API_KEY);
  return found.ok ? back(c, "ok", `Saved ${place.name}: Google found ${found.address}.`) : back(c, "err", `Saved ${place.name} as typed, but it is not verified: ${found.message}`);
});

plansRoutes.post("/places/:id/delete", dashboardAccess, (c) => {
  if (!sameSiteOnly(c)) return c.text("Forbidden", 403);
  const place = getPlace(db, Number(c.req.param("id")));
  if (!place) return back(c, "err", "That place no longer exists.");
  deletePlace(db, place.id);
  return back(c, "ok", `Deleted ${place.name}.`);
});

plansRoutes.post("/places/verify-all", dashboardAccess, async (c) => {
  if (!sameSiteOnly(c)) return c.text("Forbidden", 403);
  let found = 0;
  let failed = 0;
  let firstProblem = "";
  for (const p of listPlaces(db).filter((p) => p.address && !p.verified)) {
    const r = await verifyPlace(db, p.id, config.GOOGLE_MAPS_API_KEY);
    if (r.ok) found++;
    else {
      failed++;
      firstProblem ||= r.message;
    }
  }
  return failed ? back(c, "err", `Google found ${found}; ${failed} could not be verified. ${firstProblem}`) : back(c, "ok", `Google found ${found} address${found === 1 ? "" : "es"}.`);
});
