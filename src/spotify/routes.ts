import { randomBytes } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { config } from "../config";
import { db } from "../db";
import { esc, layout } from "../html";
import { runJobNow } from "../runner";
import { spotifyAuth } from "./index";
import { JOB_NAME, PLAY_THRESHOLD, POLL_CRON, WINDOW_DAYS } from "./settings";
import { apiCallsToday } from "./usage";

export const spotifyRoutes = new Hono();

// ---- Who can reach what ----------------------------------------------------
// These pages show my listening history and can change my library. Every route here
// is served to this Mac, or through the Cloudflare tunnel. The tunnel is protected by
// Cloudflare Access, which logs me in before a request reaches Jarvis. As a second check
// we only serve tunnel requests that arrive on our own hostname and carry the Access header.
// (If SPOTIFY_REDIRECT_URI is the 127.0.0.1 one, logging in only works on this Mac,
// because Spotify sends the browser back to 127.0.0.1.)
const LOCAL_HOSTS = [`127.0.0.1:${config.PORT}`, `localhost:${config.PORT}`];

function isLocalRequest(c: Context): boolean {
  const viaCloudflare = c.req.header("cf-connecting-ip") || c.req.header("cf-ray");
  return LOCAL_HOSTS.includes(c.req.header("host") ?? "") && !viaCloudflare;
}

function isAccessTunnelRequest(c: Context): boolean {
  return (
    c.req.header("host") === config.PUBLIC_HOST && Boolean(c.req.header("cf-access-jwt-assertion"))
  );
}

const dashboardAccess: MiddlewareHandler = async (c, next) => {
  if (!isLocalRequest(c) && !isAccessTunnelRequest(c)) return c.text("Forbidden", 403);
  await next();
};

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
interface RunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  duration_ms: number | null;
  log: string | null;
}
interface TrackRow {
  track_id: string;
  name: string;
  artists: string;
  last_played: string;
  plays_in_window: number;
  plays_total: number;
  is_liked: number | null;
  like_source: string | null;
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-AU", { hour12: false }) : "-");

function likedLabel(t: TrackRow): { text: string; cls: string } {
  if (t.like_source === "jarvis") return { text: "Liked by Jarvis", cls: "liked" };
  if (t.is_liked === 1) return { text: "Liked", cls: "liked" };
  if (t.is_liked === 0) {
    const due = t.plays_in_window > PLAY_THRESHOLD;
    if (!due) return { text: "Not liked", cls: "" };
    return config.SPOTIFY_DRY_RUN
      ? { text: "Not liked (would like, dry run)", cls: "pending" }
      : { text: "Not liked (will like next run)", cls: "pending" };
  }
  return { text: "Not checked yet", cls: "muted" };
}

spotifyRoutes.get("/", dashboardAccess, (c) => {
  // Which run's output to show: ?run=<id>, otherwise the latest run of this job.
  const runParam = Number(c.req.query("run"));
  const run = (
    Number.isInteger(runParam) && runParam > 0
      ? db.prepare(`SELECT * FROM runs WHERE id = ? AND job = ?`).get(runParam, JOB_NAME)
      : db.prepare(`SELECT * FROM runs WHERE job = ? ORDER BY id DESC LIMIT 1`).get(JOB_NAME)
  ) as RunRow | undefined;

  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const tracks = db
    .prepare(
      `SELECT p.track_id,
              MAX(p.track_name) AS name,
              MAX(p.artists) AS artists,
              MAX(p.played_at) AS last_played,
              SUM(CASE WHEN p.played_at >= ? THEN 1 ELSE 0 END) AS plays_in_window,
              COUNT(*) AS plays_total,
              s.is_liked AS is_liked,
              l.source AS like_source
         FROM play_history p
         LEFT JOIN track_status s ON s.track_id = p.track_id
         LEFT JOIN likes l ON l.track_id = p.track_id
        GROUP BY p.track_id
        ORDER BY last_played DESC
        LIMIT 50`,
    )
    .all(windowStart) as TrackRow[];

  const connected = spotifyAuth.isConnected();
  const connection = !spotifyAuth.isConfigured()
    ? `<span class="error">Not configured</span> (add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to .env)`
    : connected
      ? `<span class="liked">Connected</span>`
      : `<span class="error">Not connected</span> - <a href="/spotify/login">log in to Spotify</a>`;
  const mode = config.SPOTIFY_DRY_RUN
    ? `<strong class="pending">DRY RUN</strong> (logs what it would like, likes nothing)`
    : `<strong class="liked">LIVE</strong> (really likes songs)`;

  const busy = c.req.query("notice") === "busy"
    ? `<p class="pending">The job is already running (or disabled). Try again in a moment.</p>`
    : "";

  const output = run
    ? `<h2 id="output">Output of run #${run.id}</h2>
       <p>Status: <span class="${esc(run.status)}">${esc(run.status)}</span> ·
          started ${esc(fmt(run.started_at))} · ${run.duration_ms ?? "-"} ms</p>
       <pre>${esc(run.log || "(no output)")}</pre>`
    : `<h2 id="output">Output</h2><p class="muted">No runs yet. Press "Run now".</p>`;

  const rows = tracks
    .map((t) => {
      const label = likedLabel(t);
      return `<tr>
        <td>${esc(t.name)}</td><td>${esc(t.artists)}</td>
        <td>${esc(fmt(t.last_played))}</td>
        <td>${t.plays_in_window}</td><td>${t.plays_total}</td>
        <td class="${label.cls}">${esc(label.text)}</td></tr>`;
    })
    .join("");

  return c.html(
    layout(
      "Jarvis - Spotify",
      `<p><a href="/">&larr; Jobs</a></p>
<h1>Spotify auto-like</h1>
<p>Connection: ${connection}<br>
   Mode: ${mode}<br>
   Rule: like a song played more than ${PLAY_THRESHOLD} times in ${WINDOW_DAYS} days<br>
   Schedule: <code>${esc(POLL_CRON)}</code> (every 2 hours) · API calls today: ${apiCallsToday(db)}</p>

<form method="post" action="/spotify/run"><button type="submit">Run now</button></form>
${busy}
${output}

<h2>Recently played</h2>
<p class="muted">Times are this Mac's local time. "Plays (${WINDOW_DAYS} days)" is what the rule counts.</p>
<table>
<tr><th>Song</th><th>Artist</th><th>Last played</th><th>Plays (${WINDOW_DAYS} days)</th><th>Plays (all stored)</th><th>Liked?</th></tr>
${rows || `<tr><td colspan="6" class="muted">No plays stored yet. Run the job once Spotify is connected.</td></tr>`}
</table>`,
    ),
  );
});
