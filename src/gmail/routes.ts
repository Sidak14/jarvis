import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { dashboardAccess } from "../access";
import { esc, layout } from "../html";
import { runJobNow } from "../runner";
import { gmailAuth } from "./index";
import { JOB_NAME } from "./settings";
import { liveContext } from "../ui/context";
import { invoicesPage } from "../ui/pages/invoices";
import { buildGmail } from "../ui/vm/gmail";

export const gmailRoutes = new Hono();

// Same access rules as /spotify (this Mac, or the Cloudflare Access tunnel).
const pendingStates = new Map<string, number>(); // login state -> expiry (ms)
const STATE_TTL_MS = 10 * 60 * 1000;

const notice = (title: string, message: string, isError = false) =>
  layout(
    title,
    `<h1>${esc(title)}</h1><p class="${isError ? "error" : ""}">${esc(message)}</p>
     <p><a href="/gmail">Back to the Gmail page</a></p>`,
  );

gmailRoutes.get("/login", dashboardAccess, (c) => {
  if (!gmailAuth.isConfigured()) {
    return c.html(notice("Gmail is not configured", "Add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET to .env and restart Jarvis.", true), 400);
  }
  const state = randomBytes(16).toString("hex");
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  return c.redirect(gmailAuth.authorizeUrl(state));
});

gmailRoutes.get("/callback", dashboardAccess, async (c) => {
  const state = c.req.query("state") ?? "";
  const expiry = pendingStates.get(state);
  pendingStates.delete(state); // each state works once
  if (!expiry || expiry < Date.now()) {
    return c.html(notice("Login failed", "Unknown or expired login attempt. Start again from /gmail/login.", true), 400);
  }
  const googleError = c.req.query("error");
  if (googleError) return c.html(notice("Login cancelled", `Google said: ${googleError}`, true), 400);
  const code = c.req.query("code");
  if (!code) return c.html(notice("Login failed", "Google did not send a code.", true), 400);
  try {
    await gmailAuth.exchangeCode(code);
  } catch (err) {
    return c.html(notice("Login failed", (err as Error).message, true), 502);
  }
  return c.html(notice("Gmail connected", "Login saved (read-only). Jarvis will refresh it automatically."));
});

gmailRoutes.post("/run", dashboardAccess, async (c) => {
  const origin = c.req.header("origin"); // block other websites posting to this page
  if (origin && new URL(origin).host !== c.req.header("host")) return c.text("Forbidden", 403);
  const runId = await runJobNow(JOB_NAME);
  if (runId === null) return c.redirect("/gmail?notice=busy", 303);
  return c.redirect(`/gmail?run=${runId}#output`, 303);
});

gmailRoutes.get("/", dashboardAccess, (c) => {
  const ctx = liveContext();
  const vm = buildGmail(ctx, { filter: c.req.query("result"), runId: Number(c.req.query("run")) });
  return c.html(invoicesPage(vm, ctx.now, { busy: c.req.query("notice") === "busy" }));
});
