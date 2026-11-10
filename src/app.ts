import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { config } from "./config";
import { db } from "./db";
import { expensesSection } from "./expenses/status";
import { esc } from "./html";
import { triggerJob } from "./runner";
import { spotifyRoutes } from "./spotify/routes";
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

interface JobRow {
  name: string;
  schedule: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: string | null;
}
interface RunRow {
  id: number;
  job: string;
  started_at: string;
  status: string;
  duration_ms: number | null;
}

const listJobs = db.prepare(
  `SELECT j.name, j.schedule, j.enabled, j.last_run_at, j.next_run_at,
          (SELECT status FROM runs r WHERE r.job = j.name ORDER BY r.id DESC LIMIT 1) AS last_status
     FROM jobs j ORDER BY j.name`,
);
const latestRuns = db.prepare(
  `SELECT id, job, started_at, status, duration_ms FROM runs ORDER BY id DESC LIMIT 20`,
);

export const app = new Hono();

// Minimal request log: method, path, status. Never headers, bodies or config.
app.use("*", async (c, next) => {
  await next();
  console.log(`[http] ${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status}`);
});

app.get("/health", (c) => c.json({ ok: true }));

// Spotify dashboard, login and manual run. Local-only (see spotify/routes.ts).
app.route("/spotify", spotifyRoutes);

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
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    try {
      const result = await hook({ body, log: (m) => console.log(`[webhook:${name}] ${m}`) });
      return c.json(result.body, result.status);
    } catch (err) {
      console.error(`[webhook:${name}] failed:`, (err as Error).message);
      return c.json({ error: "internal error" }, 500);
    }
  }

  if (!triggerJob(name)) return c.json({ error: "unknown job" }, 404);
  return c.json({ ok: true, triggered: name }, 202);
});

app.get("/", (c) => {
  const jobs = listJobs.all() as JobRow[];
  const runs = latestRuns.all() as RunRow[];

  const jobRows = jobs
    .map(
      (j) => `<tr>
        <td>${esc(j.name)}</td><td><code>${esc(j.schedule)}</code></td>
        <td>${j.enabled ? "yes" : "no"}</td>
        <td>${esc(j.last_run_at ?? "never")}</td>
        <td>${esc(j.last_status ?? "-")}</td>
        <td>${esc(j.next_run_at ?? "-")}</td></tr>`,
    )
    .join("");
  const runRows = runs
    .map(
      (r) => `<tr>
        <td>${r.id}</td><td>${esc(r.job)}</td><td>${esc(r.started_at)}</td>
        <td class="${esc(r.status)}">${esc(r.status)}</td>
        <td>${r.duration_ms ?? "-"}</td></tr>`,
    )
    .join("");

  return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jarvis</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:60rem;padding:0 1rem}
  table{border-collapse:collapse;width:100%;margin-bottom:2rem}
  th,td{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #8884}
  .success{color:#1a7f37}.failure{color:#cf222e}.running{color:#9a6700}
</style></head><body>
<h1>Jarvis</h1>
<p><a href="/spotify">Spotify dashboard</a></p>
${expensesSection(db)}
<h2>Jobs</h2>
<table><tr><th>Name</th><th>Schedule</th><th>Enabled</th><th>Last run (UTC)</th><th>Last status</th><th>Next run (UTC)</th></tr>
${jobRows || '<tr><td colspan="6">No jobs registered</td></tr>'}</table>
<h2>Latest 20 runs</h2>
<table><tr><th>#</th><th>Job</th><th>Started (UTC)</th><th>Status</th><th>ms</th></tr>
${runRows || '<tr><td colspan="5">No runs yet</td></tr>'}</table>
</body></html>`);
});
