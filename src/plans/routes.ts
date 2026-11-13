import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { dashboardAccess } from "../access";
import { esc, layout } from "../html";
import { liveContext } from "../ui/context";
import { plansPage } from "../ui/pages/plans";
import { buildPlans } from "../ui/vm/plans";
import { calendarAuth } from "./index";

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
  return c.html(plansPage(buildPlans(ctx), ctx.now));
});
