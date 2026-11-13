# Jarvis

Personal assistant server: Hono + better-sqlite3 + croner + zod, TypeScript on Node 22.

## Layout

- `src/config.ts` reads `.env`, validates it with zod. Secrets are never logged.
- `src/db.ts` SQLite at `data/jarvis.db`: `jobs`, `runs`, `api_usage`.
- `src/runner.ts` `registerJob(name, cron, handler)`. Every run is recorded in `runs`
  (status, duration, captured log). A failing job never crashes the server.
- `src/jobs/` job definitions. `heartbeat` runs every 5 minutes.
- `src/app.ts` routes. `src/server.ts` entry point, binds to `127.0.0.1:8080` only.
- `launchd/` service plist.

## Setup

```
cp .env.example .env        # then set WEBHOOK_SECRET (openssl rand -hex 32)
npm install
npm run build
npm start
```

## Routes

| Route | Auth | Notes |
| --- | --- | --- |
| `GET /health` | none | `{"ok":true}` |
| `GET /` | none | jobs and the 20 latest runs (no logs shown) |
| `POST /webhook/:name` | `Authorization: Bearer <WEBHOOK_SECRET>` | runs job `:name` now. 401 bad/missing secret, 404 unknown job, 202 started |

The secret is compared in constant time. The auth check happens before the job lookup.

`POST /webhook/expenses` is special: it has a handler that reads the JSON body (see Expenses
below). A handler registered with `registerWebhook(name, fn)` in `src/webhooks.ts` wins over a
job with the same name; every other name still just triggers the job.

## Adding a job

```ts
import { registerJob } from "../runner";
registerJob("my-job", "0 9 * * *", async ({ log }) => { log("hello"); });
```

Call it from `src/server.ts`, rebuild, restart.

## Running as a service

`launchd/com.jarvis.server.plist` runs `node dist/server.js` with `RunAtLoad` and `KeepAlive`
(currently installed as a LaunchDaemon). After `npm run build`, restart by stopping the
process (launchd relaunches it), or `sudo launchctl kickstart -k system/com.jarvis.server`.
Logs go to `logs/`. The Cloudflare tunnel runs separately as `com.cloudflare.cloudflared`
and maps the public hostname to `http://127.0.0.1:8080`.

## Spotify auto-like

Likes any song played more than 4 times in 2 days (`src/spotify/settings.ts`).

- `spotify-likes` job runs every 2 hours. Spotify only returns the last 50 plays, so each
  run stores them in `play_history` (deduped by track id + played_at) and counts from there.
- The rule, the thresholds and the cron schedule are all in `src/spotify/settings.ts`.
- `GET /spotify`: status, **Run now** button with the job's output, and the recently played
  songs with play counts and liked status. Works from this Mac and, behind Cloudflare Access,
  from anywhere via the tunnel.
- Setup: create an app at developer.spotify.com/dashboard (owner needs Premium), register a
  redirect URI, put `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env`, restart, then
  open `/spotify/login` from any device. The redirect URI defaults to
  `https://<PUBLIC_HOST>/spotify/callback` (so `https://jarvis.gurveerkhalsa.com/spotify/callback`);
  register exactly that in the Spotify dashboard. Set `SPOTIFY_REDIRECT_URI` to override it.
- `SPOTIFY_DRY_RUN=true` (the default) only logs what it would like. Set `false` to go live.
- Tokens live in `data/jarvis.db` (mode 600), refresh automatically, and are never logged.
  Spotify refresh tokens last about 6 months; log in again when the dashboard asks.
- Tests: `npm test` (fake Spotify, in-memory database, no real account needed).

## Expenses (wallet taps -> Google Sheet)

An iOS Shortcut (Wallet transaction automation) POSTs each tap to Jarvis, which stores it and
writes a row to a Google Sheet. The goal is never losing an expense, and making failures visible.

- Shortcut: `POST https://jarvis.gurveerkhalsa.com/webhook/expenses` with headers
  `Authorization: Bearer <WEBHOOK_SECRET>` and `Content-Type: application/json`, and a JSON body
  with one field: `{"raw_data": <Shortcut Input>}`. (Found in testing: Wallet's Shortcut Input
  arrived as an empty string here, so this will change to separate merchant/amount/card fields.)
- The webhook stores whatever it receives in the `expenses` table and answers 202; it never
  waits on Google. Only a wrong secret (401) or a body over 64 KB (413) is refused, so a broken
  Shortcut cannot silently lose a tap.
- `src/expenses/parse.ts` reads merchant, amount (to integer cents), card, time and currency
  (default AUD) out of `raw_data`. If it cannot, the expense is still stored as `unparsed`
  (202), shown in red on the status page, and re-read on every sync after the parser is fixed.
- Duplicates: the same merchant + amount + card within 2 minutes is stored as `duplicate`
  and never synced.
- `expenses-sync` job (every 15 minutes, and right after a new expense) appends rows to the
  Sheet with a service account (columns Date, Merchant, Amount, Currency, Card, ID). An
  expense is `synced` only after Google confirms. Failures stay `pending` and are retried
  forever. Column F holds `jarvis-<id>`; before retrying an expense that may already have
  reached Google, the sync looks for that id so nothing is written twice.
- Each Google HTTP call is counted in `api_usage` (provider `google_sheets`).
- The first 20 request bodies are logged in full to `logs/server.out.log` (to tune the parser).
  Every body is also kept in `expenses.raw_payload`.
- Without `GOOGLE_SHEET_ID` / `GOOGLE_SERVICE_ACCOUNT_FILE`, expenses are still stored and
  the sync waits. The status page (`GET /`) shows the pending count, the last sync error,
  anything stuck for over an hour, and the latest 20 expenses.
- Setup: create a Google Cloud service account, enable the Sheets API, download its JSON key to
  `secrets/google-sa.json` (`chmod 600`, `secrets/` is git-ignored), share the Sheet with the
  service account's email as Editor, put the two values in `.env`, restart.

## Expenses from invoice emails (Gmail)

Every hour the `gmail-expenses` job reads new Gmail and adds payment receipts to the same
`expenses` table as the Wallet taps. Code is in `src/gmail/`, `src/ai/` and `src/expenses/`.

- **Gmail:** read-only (`gmail.readonly`) OAuth. Tokens live in `data/jarvis.db` (`gmail_auth`,
  mode 600). Log in at `/gmail/login`. If the Google OAuth app is in "Testing", Google expires
  the refresh token after 7 days; the page then asks you to log in again.
- **Cheap filter first:** a broad Gmail search (last 7 days; receipt, invoice, bill, expense, payment,
  paid, order, charge, subscription, booking ... in the subject or body; only social/forums left out, so
  receipts that land in Promotions are still read), skipping ids in `processed_emails`, then a code check (needs an
  amount, no promo subject). Only what is left goes to the LLM.
- **LLM:** Vercel AI Gateway, `anthropic/claude-haiku-5.5` (`src/ai/settings.ts`). The email is
  sent as data inside `<email>` tags and the model only fills a zod schema
  (`is_invoice, merchant, amount, currency, occurred_at, confidence`). Code then sanity-checks
  amount, currency and date and decides what happens. Nothing the email says can trigger an action.
- **Caps:** 100 LLM calls/day and $10/month (estimated from tokens), enforced in `src/ai/llm.ts`.
  Every call is in `api_usage` (provider `ai_gateway`: calls, tokens, estimated cost). When a cap is
  hit the run fails and the status page says so.
- **Dedupe (`src/expenses/match.ts`, one function for both directions):** same `amount_cents` +
  currency within 48 hours and a different source = same purchase. A tap arriving after an email
  (or the reverse) is merged, not added; the better merchant name is kept (a messy terminal string
  like `SQ *CAFE 1234` is replaced by the email's clean name, and just that Sheet cell is updated).
  Each expense is matched once, so two real purchases of one amount on different days stay two rows.
  Same-source repeats keep the 2-minute rule. `email_message_id` is unique.
- **Sheet:** column A is a full date and time (`yyyy-mm-dd hh:mm:ss`; Jarvis sets that column format
  once per run). A tap uses the moment the webhook was called unless Wallet sends its own time.
  An email uses the time the model finds, or the time the email arrived when it only names a date.
  Column G is `Source` (`tap` or `email`); add the header yourself.
- **Invoice + receipt:** a paid invoice and its receipt email for the same merchant and amount (within
  7 days) count as one expense; two receipts are two purchases unless their timestamps match.
- **Dry run first:** with `GMAIL_DRY_RUN=true` (default) it only logs `WOULD add ...` /
  `WOULD merge into ...` (see `/gmail`) and writes no expenses. Set `false` and restart to go live;
  emails seen in dry-run are then processed for real.
- **Privacy:** email text is held in memory only. We store the message id, what we decided, and
  the extracted fields. The email text is sent to the AI Gateway (and the model provider) to be read.
- `/gmail` shows connection, last run, spend, the run output with a **Run now** button, and the
  latest processed emails.

## Telegram (the chat interface)

Jarvis talks to you on Telegram. No LLM: every reply is deterministic code. Code is in `src/telegram/`.

- **Long polling** (`getUpdates`) inside the main service, so nothing new is exposed through the
  tunnel. **Locked to one person:** updates from anyone but `TELEGRAM_OWNER_ID` (or from outside
  your private chat with the bot) are dropped silently. With no owner id set, `/start` replies with
  the sender's id once, and nothing else works.
- **Messages are data.** The only things that do anything: the fixed commands `/status /spend
  /unlabeled /recent /log /help /start`, `/recat <id> <number>` (changes a category, strict pattern), and a
  reply to a question (a number, or text stored as data: cleaned, max 200 chars). There are no
  buttons (some chat apps do not show them). No shell, no eval. Messages over 500 chars are
  refused, and more than 20 a minute are ignored. All outgoing text is plain text (no Markdown/HTML).
- **Outbox:** `notify(text, options)` (from `src/telegram`) writes to the `outbox` table FIRST, then
  tries to send. The `telegram-outbox` job (every minute) retries failures with backoff (1, 2, 4, 8,
  15, 30, 60 min), in order, and gives up after 50 attempts (`failed`, shown on the status page).
  Alerts pass `dedupeKey` + `cooldownMs` so a stuck problem does not spam. Delivery is at-least-once.
- **Categorising** (`expenses-categorise`, **off until `TELEGRAM_QUESTIONS_ENABLED=true`**): the
  webhook and Gmail jobs start it the moment an expense is saved; a 9pm Sydney run is the safety net.
  For each uncategorised expense: (1) if that merchant's last 5 categories all agree, reuse it (no AI);
  (2) otherwise ask the AI, showing it the merchant's last 5 categories and everything logged in the
  previous 12 hours. It answers a typed JSON (`{category, confidence, reason}`, checked with zod, one
  retry); only "high" confidence and not "Other" is saved (`category_source = ai`); (3) otherwise
  you get a message straight away (no daily limit):
  `$12.50 at Cafe, 2:14pm. What was this for?` then `1. Food and drinks ... 6. Jarvis and tech, 7. Other, 8. Skip`.
  Reply to it with a number; anything else is saved as Other with your words as the note. Skip means
  never ask again. `asked_at` is set as the question is queued, so an expense is asked about once, ever.
  AI errors are retried (3 times), a hit AI cap or missing AI key means asking you. Expenses older
  than 2 days are never asked about. Merged tap/email rows are one expense row, so they count once.
  Messages that can wait (questions, alerts) are held while it is before 9am or after 11pm in Sydney.
  `/log yesterday 45 at Star Casino` adds an expense by hand: the AI reads the day ("2 days ago",
  "last monday"), amount, optional time (default 12:00pm) and merchant ("to friends" -> Friends) into a
  typed object; code checks it (real date, not future, amount sane) and saves it as source `manual`,
  then it is synced and categorised like any other. It replies with what it saved.
  `/recent` shows the last 10 with who chose each category; `/recat <id> <number>` fixes one.
- **Sheet:** columns H `Category` and I `Purpose` (add the headers). Answers are pushed to the
  existing row by the normal sync (retried until it works).
- **Monthly recap** (`telegram-recap`, 9am Sydney, sent once per month for the month just ended; it
  catches up for 3 days if the Mac was off on the 1st): total (AUD), count, by category, top 5
  merchants, change vs the month before, and how many are unlabeled. `monthly_recaps` has the month
  as its primary key, so a month is never sent twice.
- **Alerts** (`health-alerts`, every 10 min, each with a cooldown): sheet rows pending over 1 hour or
  an error repeating, Gmail login failures, a login/consent ending within 14 days (`consents` table;
  set `GMAIL_CONSENT_DAYS=7` while the Google app is in "Testing"), AI spend at 80% or the cap, and any
  job failing 3 runs in a row (`jobs.consecutive_failures`).
  **Jarvis cannot alert when the Mac mini itself is down** (see below).
- **Quiet jobs:** `registerJob(..., { quiet: true })` does not record a successful run that logged
  nothing, so a per-minute job does not bury the run history. `{ timezone }` sets a cron time zone.
- **Setup:** create the bot with BotFather, put `TELEGRAM_BOT_TOKEN` in `.env`, restart, message the
  bot `/start`, put the id it replies with in `TELEGRAM_OWNER_ID`, restart (a test message arrives),
  then set `TELEGRAM_QUESTIONS_ENABLED=true` and restart.
- **Dead-man's switch (not built):** the cheapest way to hear about the Mac being down is an outside
  service that expects a ping, such as a free Healthchecks.io check: the `heartbeat` job would request
  its ping URL every 5 minutes, and Healthchecks emails or texts you when the pings stop.

## Plans (Beeper chats -> plans.md -> Telegram -> Google Calendar)

Reads chats through Beeper Server's local API (**read-only**, `@beeper/desktop-api`), finds plans
with Haiku, tracks them in `data/plans.md`, pings you on Telegram and, for plans you have committed
to, adds them to your Google Calendar. `/plans` shows everything.

- **Safe by default:** `PLANS_DRY_RUN=true` does everything except touch the calendar or send pings;
  what it WOULD do is logged and shown on `/plans`. Flip it to `false` after a few days of checking.
- **Setup:** Beeper Server (headless; Desktop needs macOS 13+, this Mac is on 12) signed in and set to
  start at login (see "Beeper Server on this Mac" below), token -> `BEEPER_ACCESS_TOKEN` in `.env`. Run `npm run build && npm run chats`
  to list your chats, then write `data/plans-chats.json`:
  `{ "chats": [ { "id": "<chat id>", "name": "Footy boys" } ] }`. Add
  `https://<PUBLIC_HOST>/calendar/callback` as a redirect URI in Google Cloud, enable the Google
  Calendar API, then open `/calendar/login` and tick both permissions. Restart.
- **Instagram only:** `ALLOWED_BRIDGES` in `settings.ts` limits reading to Instagram. WhatsApp, Telegram, Slack and the rest are never listed or read (a test checks this and that only GET requests are sent). The token is the Server's read+write login token (the headless Server cannot grant a read-only one), so "read-only" is enforced by the code, not the token.
- **What is read:** allowlisted chats (groups or DMs), plus DMs with anyone in an allowlisted group.
  `PLANS_ALL_CHATS=true` reads every chat on an allowed network. A DM only goes to the model if a cheap code check matches
  (time/date/day words, "keen", event words) or the sender is in a chat with an open plan in the next
  14 days. First start: only messages from then on (`PLANS_BACKFILL=true` also takes 7 days).
- **How:** `plans-poll` (every 5 min) reads new text messages and reactions (local, free), then runs
  detection on each chat that has been quiet for 3 minutes (or busy for 30). Message text is kept only
  until its batch is processed, then erased; only ids stay. One Haiku call per batch, logged in
  `api_usage` and under the usual spend caps. The model fills a zod schema; plain code
  (`src/plans/apply.ts`) decides everything. Your stance only ever comes from messages YOU wrote.
- **Stance vs status:** stance (committed / declined / unsure) is your latest explicit statement by
  message time, across all linked chats; "what time?" never changes it. Status (proposed / confirmed /
  cancelled) is whether it is really going ahead. A plan goes on the calendar only if committed +
  confirmed + exact day and time + confident, and nothing overlaps (any calendar). Max 5 new events a day.
- **Telegram (no buttons, Beeper does not show them):** each message ends with a command:
  `/undo P-0001`, `/addback P-0001`, `/addanyway P-0001` (after a clash), `/keep` / `/remove P-0001`
  (after you said maybe), `/plans`. One ping per plan version if you have not replied.
- **Files:** `plans.md` is written by code only (temp file + rename, backup first, one writer at a
  time) from the database; plans 14+ days past move to `plans-archive.md`. If the database is empty
  and `plans.md` exists, it is loaded back.
- **Checked live (Beeper Server 4.3.284):** pages come newest-first; `after <sortKey>` returns newer
  messages; reactions are embedded on messages (a separate REACTION message type also exists and is
  ignored); `isSender` / `isSelf` identify you. The reader still sorts by timestamp itself and
  re-reads the last 3 days of each active chat to notice new reactions.

### Beeper Server on this Mac

The CLI (`beeper-cli`) installs a *staging* build, so the production Server is run by hand:
unzip `beeper-server-<version>-macos-x64.zip` from Beeper's official feed into `~/beeper-prod-test/app`,
and the LaunchAgent `~/Library/LaunchAgents/com.jarvis.beeper-server.plist` runs it with
`HOME=~/beeper-prod-test/home` (its own data dir). It listens on 127.0.0.1:23373 only, uses about 1 GB
of RAM and starts when you log in (auto-login must stay on). To update it, replace the app folder and
`launchctl unload` / `load` the agent. If it is down, plans-poll just logs it and tries again.

## Dashboard (UI)

Six pages behind Cloudflare Access, sharing one nav: **Overview** `/`, **Expenses** `/expenses`, **Plans** `/plans`,
**Spotify** `/spotify`, **Invoices** `/gmail`, **Jobs** `/jobs`. Server-rendered HTML plus `public/dashboard.css` and a tiny
`public/dashboard.js` (sorting, expandable rows, instant filters, live "x min ago", optional 60s auto-refresh). No build
step, no framework, no external fonts, scripts or analytics. Times are Australia/Sydney everywhere.

- **Where things live (`src/ui`):** `vm/*` builds plain-data view-models (`ModuleStatus`, `OverviewVM`, `ExpenseRowVM`, `JobVM`,
  `PlanVM`...) from the database, with no HTML, so they are unit-tested. `pages/*` turns a view-model into HTML using
  `components.ts` (PageLayout, StatusPill, StatTile, Card, DataTable, RelativeTime, Money, EmptyState, Banner). `format.ts` is the
  only place money, dates, relative times and cron schedules are formatted. `html.ts` is a tagged template (`h`) that escapes
  every interpolated value, so merchant names, chat names and plan titles can not become markup.
- **Health banner:** the Overview lists everything that needs attention and links to it. A job is **overdue** when its next run is
  more than 2 intervals (never under 10 minutes) in the past, or it never reported and its first run is late. Overdue jobs make the
  banner amber; failing jobs make it amber, and red from 3 in a row. A job in the database that this server no longer schedules is
  shown as "retired" (collapsed on the Jobs page) and is not checked.
- **Filters** on Expenses (month, source, category, sheet status, search, "show test rows") are plain GET forms, so they work
  without JavaScript. Rows whose merchant contains the word TEST are hidden by default and never counted in totals.
- **AI spend** is the real total (all features share one cap) plus a per-feature breakdown from `ai_usage_by_feature`. Calls are
  tagged `invoices`, `plans`, `categorising` or `log`; spend from before tagging shows as "earlier or untagged".
- **Changing the CSS or JS:** bump `ASSET_VERSION` in `src/ui/components.ts` so browsers fetch the new file.

## Notes

The dashboard (`GET /`) and `/spotify` are behind Cloudflare Access. `/health` and
`/webhook/*` are the only public routes; the webhook needs the bearer secret. As a second
check, tunnel requests to `/spotify` are only served if they arrive on `PUBLIC_HOST` and carry
the `Cf-Access-Jwt-Assertion` header. That header is checked for presence only, not verified.
