import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { dashboardAccess } from "../access";
import { db } from "../db";
import { esc, layout } from "../html";
import { runJobNow } from "../runner";
import { gmailAuth } from "./index";
import { JOB_NAME } from "./settings";
import { gmailSection } from "./status";

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

interface RunRow {
  id: number;
  started_at: string;
  status: string;
  duration_ms: number | null;
  log: string | null;
}
interface EmailRow {
  message_id: string;
  processed_at: string;
  result: string;
  detail: string | null;
  dry_run: number;
}

const fmt = (iso: string) => new Date(iso).toLocaleString("en-AU", { hour12: false });

gmailRoutes.get("/", dashboardAccess, (c) => {
  const runParam = Number(c.req.query("run"));
  const run = (
    Number.isInteger(runParam) && runParam > 0
      ? db.prepare(`SELECT * FROM runs WHERE id = ? AND job = ?`).get(runParam, JOB_NAME)
      : db.prepare(`SELECT * FROM runs WHERE job = ? ORDER BY id DESC LIMIT 1`).get(JOB_NAME)
  ) as RunRow | undefined;
  const emails = db
    .prepare(`SELECT message_id, processed_at, result, detail, dry_run FROM processed_emails ORDER BY processed_at DESC, rowid DESC LIMIT 30`)
    .all() as EmailRow[];

  const busy = c.req.query("notice") === "busy" ? `<p class="pending">The job is already running. Try again in a moment.</p>` : "";
  const output = run
    ? `<h2 id="output">Output of run #${run.id}</h2>
       <p>Status: <span class="${esc(run.status)}">${esc(run.status)}</span> · started ${esc(fmt(run.started_at))} · ${run.duration_ms ?? "-"} ms</p>
       <pre>${esc(run.log || "(no output)")}</pre>`
    : `<h2 id="output">Output</h2><p class="muted">No runs yet. Press "Run now".</p>`;
  const rows = emails
    .map(
      (e) => `<tr><td><a href="https://mail.google.com/mail/u/0/#all/${encodeURIComponent(e.message_id)}" target="_blank" rel="noreferrer">${esc(e.message_id)}</a></td>
        <td>${esc(fmt(e.processed_at))}</td><td class="${e.result === "error" ? "failure" : e.result === "invoice" ? "success" : "muted"}">${esc(e.result)}${e.dry_run ? " (dry run)" : ""}</td>
        <td>${esc(e.detail ?? "")}</td></tr>`,
    )
    .join("");

  return c.html(
    layout(
      "Jarvis - Gmail",
      `<p><a href="/">&larr; Jobs</a></p>
<h1>Gmail invoices</h1>
${gmailSection(db)}
<form method="post" action="/gmail/run"><button type="submit">Run now</button></form>
${busy}
${output}
<h2>Latest processed emails</h2>
<p class="muted">Only the message id and what we decided are kept, never the email text. Click an id to open it in Gmail.</p>
<table><tr><th>Message</th><th>Processed</th><th>Result</th><th>Detail</th></tr>
${rows || `<tr><td colspan="4" class="muted">Nothing processed yet.</td></tr>`}</table>`,
    ),
  );
});
