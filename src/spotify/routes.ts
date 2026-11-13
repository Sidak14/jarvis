import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { dashboardAccess } from "../access";
import { esc, layout } from "../html";
import { runJobNow } from "../runner";
import { spotifyAuth } from "./index";
import { liveContext } from "../ui/context";
import { spotifyPage } from "../ui/pages/spotify";
import { buildSpotify } from "../ui/vm/spotify";
import { JOB_NAME } from "./settings";

export const spotifyRoutes = new Hono();

// ---- Login -----------------------------------------------------------------
const pendingStates = new Map<string, number>(); // state -> expiry (ms)
const STATE_TTL_MS = 10 * 60 * 1000;

const notice = (title: string, message: string, isError = false) =>
  layout(
    title,
    `<h1>${esc(title)}</h1><p class="${isError ? "error" : ""}">${esc(message)}</p>
     <p><a href="/spotify">Back to the Spotify dashboard</a></p>`,
  );

spotifyRoutes.get("/login", dashboardAccess, (c) => {
  if (!spotifyAuth.isConfigured()) {
    return c.html(
      notice("Spotify is not configured", "Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to .env and restart Jarvis.", true),
      400,
    );
  }
  const state = randomBytes(16).toString("hex");
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  return c.redirect(spotifyAuth.authorizeUrl(state));
});

spotifyRoutes.get("/callback", dashboardAccess, async (c) => {
  const state = c.req.query("state") ?? "";
  const expiry = pendingStates.get(state);
  pendingStates.delete(state); // each state works once
  if (!expiry || expiry < Date.now()) {
    return c.html(notice("Login failed", "Unknown or expired login attempt. Start again from /spotify/login.", true), 400);
  }
  const spotifyError = c.req.query("error");
  if (spotifyError) {
    return c.html(notice("Login cancelled", `Spotify said: ${spotifyError}`, true), 400);
  }
  const code = c.req.query("code");
  if (!code) return c.html(notice("Login failed", "Spotify did not send a code.", true), 400);

  try {
    await spotifyAuth.exchangeCode(code);
  } catch (err) {
    return c.html(notice("Login failed", (err as Error).message, true), 502);
  }
  return c.html(notice("Spotify connected", "Login saved. Jarvis will refresh it automatically."));
});

// ---- Run now ---------------------------------------------------------------
spotifyRoutes.post("/run", dashboardAccess, async (c) => {
  // Block other websites from posting to this page from my browser.
  const origin = c.req.header("origin");
  if (origin && new URL(origin).host !== c.req.header("host")) {
    return c.text("Forbidden", 403);
  }
  const runId = await runJobNow(JOB_NAME);
  if (runId === null) return c.redirect("/spotify?notice=busy", 303);
  return c.redirect(`/spotify?run=${runId}#output`, 303);
});

// ---- Dashboard -------------------------------------------------------------
// The page itself is built in src/ui (view-model + template); this route only reads the query string.
spotifyRoutes.get("/", dashboardAccess, (c) => {
  const ctx = liveContext();
  const vm = buildSpotify(ctx, Number(c.req.query("run")));
  return c.html(spotifyPage(vm, ctx.now, { busy: c.req.query("notice") === "busy" }));
});
