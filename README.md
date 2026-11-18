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
  with the fields at the top level: `{"merchant": ..., "amount": ..., "card": ..., "name": ...}`
  (the Shortcut's Merchant, Amount, Card or Pass and Name). Sending the whole Shortcut Input as
  `{"raw_data": ...}` does not work: Wallet's input arrived as an empty string. A `raw_data`
  key is still read if present.
- The webhook stores whatever it receives in the `expenses` table and answers 202; it never
  waits on Google. Only a wrong secret (401) or a body over 64 KB (413) is refused, so a broken
  Shortcut cannot silently lose a tap.
- `src/expenses/parse.ts` reads merchant, amount (to integer cents), card, time and currency
  (default AUD) out of `raw_data`. If it cannot, the expense is still stored as `unparsed`
  (202), shown in red on the status page, and re-read on every sync after the parser is fixed.
- A tap that cannot be read also sends a Telegram message straight away (it says whether the
  Shortcut sent nothing, sent something that is not JSON, or sent JSON with no merchant and amount).
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

## Location (phone -> where I am)

`POST /webhook/location/me` (and `/webhook/location/mom` for Mom, `/webhook/location/sukhleen` for Sukhleen; same `Authorization: Bearer` secret as the other webhooks) with
`{"kind": "location", "place": "home|work|gym", "event": "enter|leave"}`. Made for three iPhone Shortcuts
automations (Arrive / Leave) per place. The current place of each person is stored in `person_location`: entering a place
sets it to Home, Work or Gym, and leaving it sets "Other" (only if you were still there, so a late
"leave work" after "enter gym" changes nothing). Every report is also kept in `location_events`.
Anything that is not that dictionary gets a 400. Code: `src/location/`.

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
  A place is not needed: a plan with a day and time but no venue is still confirmed.
- **Photos:** a photo in a direct message (never a group) is read, but only when that DM has 3 photos or fewer lately (more is a photo dump, so all of them are ignored). A photo (an invitation, a flyer, a screenshot of a booking) is read once
  by the AI (at most 5 new photos per 5-minute poll, JPEG/PNG/WebP up to 5 MB, not GIFs or stickers). Only a
  short description is kept, as `[Photo: ...]`, and it goes through plan detection like a message from the sender.
  Photos that are not about a plan are forgotten after that one look. The photo itself is never saved, but it
  is sent to the AI to be read. Needs `AI_GATEWAY_API_KEY`; without it photos are ignored.
- **Saved places:** a home ("Home" is yours, "Rijul's house", ...) is saved once by name. The model is shown
  only the saved names (never the addresses) and reuses one when a plan is there. When a plan is at a
  new private place, Jarvis asks on Telegram for its address; reply to that message and it is saved and
  used as the calendar event's location (the event is updated). `/places` lists them, and they show on
  the Plans page. Restaurants and other public venues are not saved: the model gives their address
  when it is sure, otherwise the name and suburb (Google Calendar looks it up).
- **Telegram (no buttons, Beeper does not show them):** each message ends with a command:
  `/undo P-0001`, `/addback P-0001`, `/addanyway P-0001` (after a clash), `/keep` / `/remove P-0001`
  (after you said maybe), `/plans`. One ping per plan version if you have not replied.
- **Nights run until 5am.** Between midnight and 5am "tonight" still means the evening that began the day before, so a
  plan is not moved to the new day (the prompt says so, and `apply.ts` refuses that date change). A plan whose night is
  over is never rewritten for another day: talk about a different day becomes a new plan.
- **Plan messages expire** at 5am the day after the plan (`outbox.expires_at`): if one was held overnight and the plan is
  over by 9am, it is dropped instead of sent. The calendar event is always kept up to date, but you are only messaged
  about a new day, time or venue (what the event said last is kept in `plan_actions`, kind `synced`). If a plan moves
  or falls back to "proposed" while its event is still on the calendar, you get one message with `/remove` and `/keep`.
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

## Home screen (Samsung Family Hub): `/dashboard`

One page for the kitchen fridge, 1080x1920 portrait (it scales to other screens): the **next 7 days** (times you are busy, from
Google Calendar, never the event names), **where people are** (you, from the location webhook), the **lights**, and the
**garage door**. Dark theme, plain old-browser-friendly HTML/CSS/JS (`public/fridge.css`, `public/home*.js`, `public/lights.js`, `tv.js`, `cameras.js`, `src/fridge/`).
It is linked from the main page's nav ("Dashboard"). `/fridge` redirects to it.

- **No code. Who may open it** (`src/fridge/access.ts`): (1) this Mac, (2) any device on the **home network** that connects
  directly, with no login: the fridge opens `http://<this Mac's home address>:8080/dashboard` (give the Mac a fixed address in the
  router, a DHCP reservation), (3) someone **Cloudflare Access logged in** through the tunnel whose email is on `DASHBOARD_EMAILS`
  in `.env`. Everyone else gets 403 (logged as `[home] refused ...`).
- **Jarvis listens on the home network too** (`HOST` is `0.0.0.0`). `app.ts` makes a device there reach `/dashboard` and nothing
  else, and the webhooks still need their secret. Do not forward port 8080 on the router. The traffic is plain http on your Wi-Fi.
- **Cloudflare setup** (only for use away from home): an Access application for `<PUBLIC_HOST>/dashboard` with an **Allow** policy
  listing the emails that may log in (Cloudflare sends the login code, so it has to know them). `DASHBOARD_EMAILS` is the app's own
  second check. No Bypass policy is needed.
- **Pages** (tabs along the bottom): **Home** (`/dashboard`), **Lights** (`/dashboard/lights`: every light, from `ALL_LIGHTS`;
  Frontyard Top Lights is listed as **Locked** and can never be switched), **TV** (`/dashboard/tv`: a remote for the Samsung
  Frame; the page sends key names, `src/fridge/tv.ts` maps them, nothing else can reach the TV) and **Cameras**
  (`/dashboard/cameras`: the six NVR cameras as pictures that refresh every few seconds, tap one for a big view; Jarvis fetches
  the pictures from Home Assistant and keeps each 1.5 seconds, so the token never reaches the screen). Camera names are in
  `src/fridge/cameras.ts` (Home Assistant only calls them Channel 1 to 6).
- **Home Assistant** needs `HA_URL` and `HA_TOKEN`. The page sends a light id and "on"/"off"; the server looks the entity up in
  `src/fridge/lights.ts` (that list is the whole permission, and `NEVER_SWITCH` is refused even if added by mistake).
- **Garage:** the status is `sensor.garage_door_status` and the button calls `cover.open_cover` / `cover.close_cover` on
  `cover.garage_door` (Home Assistant only lets Open through when closed and Close when open). The button asks "Tap again" first.
- **Where people are:** `GET /dashboard/api/state` (`people`) reads `person_location` (see Location): you, Mom and Sukhleen. When you arrive home the garage opens if it is closed (not for the others); a minute after anyone leaves, a garage opened in the last 3 minutes is closed. Telegram only reports your own arrivals and departures.
- **Busy times:** `GET /dashboard/api/week`, cached 5 minutes; needs the calendar login (`/calendar/login`).
- **Reaching it:** `http://127.0.0.1:8080/dashboard` on this Mac, or `https://<PUBLIC_HOST>/dashboard`. The server only listens on
  this Mac (`HOST` in `config.ts`).
- **Changing the css or js in `public/`:** bump `HOME_ASSET_VERSION` in `src/fridge/page.ts`.

## Voice (phone calls with Jarvis: Vapi + Twilio)

I can phone Jarvis and talk to it, and Jarvis phones me about important things (first one: the garage left open 10+ minutes).
Vapi does the speech (listening, the language model, talking); Twilio is the Australian number. Jarvis stays independent of Vapi:
the tools are plain code in `src/voice/tools/`, and `src/voice/vapi.ts` (messages in) plus `vapi-api.ts` and `push.ts` (calls out,
setup) are the only files that know Vapi.

```
phone <-> Twilio number <-> Vapi (speech-to-text, LLM, text-to-speech)
                               | HTTPS, Authorization: Bearer <VAPI_WEBHOOK_SECRET>
                               v
                 Jarvis POST /voice/tools  and  /voice/events   (also under /webhook/voice)
                               v
            tool registry (src/voice/registry.ts) -> Home Assistant / Calendar / expenses / plans / Spotify
```

- **The model can only do what the tools allow.** A tool that is not in `src/voice/tools/index.ts` does not exist. Every tool has
  a name, a zod argument schema, a risk (`read` or `write`) and a time limit (under 8 seconds). Everything a tool returns
  is cleaned in code (one line, no quote marks or control characters, cut short) and the assistant is told tool results are data,
  never instructions. Only Home Assistant can be written to; everything else is read-only.
- **Tools:** `ping`, `garage_status`, `home_status`, `calendar_today`, `expenses_summary`, `plans_upcoming`,
  `spotify_recent` (read) and `close_garage`, `open_garage`, `lights_set` (write).
- **Safety is in code, not in the prompt.** There are no "are you sure?" steps: a call that comes from my own phone number can
  close the garage and switch the allowlisted lights straight away. Opening the garage is different: `open_garage` takes `words`
  (what was said) and the server checks them against `VOICE_OPEN_PHRASE` (plain text in `.env`; matched anywhere in the sentence,
  ignoring capitals and punctuation). Anything else gets "I can't open the garage door.", with no hint why. The phrase is never in
  the prompt or any reply; three misses lock opening for the rest of the call and message Telegram.
- **Who can call:** only `OWNER_PHONE`. The Vapi number has no fixed assistant; Vapi asks Jarvis ("assistant-request") and Jarvis
  answers with the assistant only for my number. Anyone else hears a refusal, never reaches the model, and I get a Telegram message
  (their number masked). Tool calls are accepted only for calls Jarvis knows (ones it placed, or inbound from my number). Caller ID
  can be faked, so it is only a filter: a spoofed call could close the garage, switch lights and read the calendar, expenses and
  plans, but could not open the garage without the phrase.
- **Allowlist:** `voice/entities.yaml` is the only Home Assistant things voice can read or change (the garage cover, and the lights
  by name). It refuses to load if the Frontyard Top Lights (main circuit) are listed. Lights are matched by name exactly (ignoring
  "the" and "lights").
- **Writes are dry by default.** `VOICE_HA_WRITES=dry` (the default): the tools say what they would do and send nothing. Set
  `VOICE_HA_WRITES=live` in `.env` and restart to let them act. Before acting they read the real state (no redundant commands), and
  afterwards they report what is true. The door takes about 15 seconds, so Open and Close only *start* it and answer at once, and
  the call carries on. `src/voice/watch.ts` then watches the door and, when it stops, adds a quiet note to the live call through
  Vapi's call control URL (`vapiNotes`) without making the assistant speak: it mentions the result at its next natural pause. If the
  door goes back to where it was, the note says it didn't go through and not to retry. (If the control URL is missing, the prompt
  has the assistant check `garage_status` before hanging up.)
- **Jarvis phones me:** a Home Assistant automation (`homeassistant/config/packages/garage.yaml`) POSTs
  `/webhook/ha/garage-open` when `sensor.garage_door_status` has been `open` for 10 minutes; a watchdog job (`voice-alerts`, every
  5 minutes) checks the garage itself in case that webhook is missed. One open `alert_episodes` row per kind: it ends when the
  garage closes; calls at most every 30 minutes and 3 a day (Sydney); the garage alert is urgent so it may call at night
  (non-urgent kinds are quiet 11pm to 7am); none at the monthly limit (Telegram only). The rules are one function (`decide` in
  `src/voice/alerts.ts`). The assistant stays silent until a person speaks, so a voicemail greeting is never played any details;
  voicemail detection hangs up without a message. If I don't answer, it goes to voicemail, is busy or fails, Telegram says so
  (including that the garage is still open).
- **Privacy:** recording, logs, packet capture, transcripts and Vapi's own summary are switched off on the assistant. Jarvis keeps
  one row per call (`voice_calls`: when, direction, duration, cost, how it ended and a one-line summary Jarvis writes itself from
  the tools used) and one per tool call (`voice_tool_calls`: tool, outcome, time; the arguments are never stored, so the passphrase
  can't end up there). What Vapi still holds with those off (checked on a real call): the call record (my number, times, cost
  breakdown, how it ended, the assistant's system prompt) but no transcript, no conversation messages, no recording and an empty log.
  The speech still passes through Vapi's providers while the call is going (speech-to-text, the model, text-to-speech), so the spoken
  passphrase is heard by them.
- **Budget:** `VOICE_MONTHLY_CAP_USD` (US$10) of what Vapi reports per call (Twilio's own charges are billed separately). A Telegram
  message at 80% and at 100%; at 100% no outbound calls and the tools answer "the monthly voice limit has been reached". Calls are
  capped at 5 minutes with a 30 second silence timeout. The cost is also added to `api_usage` under provider `vapi` (separate from
  the AI spend cap).
- **After every call** Telegram gets a one-line summary, and the Calls page (`/calls`) and the Overview "Voice" card show spend
  against the limit, calls, tool use and failures.

**Environment (`.env`, never in git):** `VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID`, `VAPI_WEBHOOK_SECRET` (32+ characters, Vapi sends
it as a bearer token), `OWNER_PHONE` (E.164, `+614...`), `VOICE_OPEN_PHRASE` (the words that let voice open the garage), `VOICE_MONTHLY_CAP_USD=10`,
`VOICE_HA_WRITES=dry|live`, `VOICE_ENABLED=true|false`, `VOICE_PATH_PREFIX` (`/voice`; Cloudflare must let it through without a
login), optional `VAPI_CREDENTIAL_ID` (a Bearer credential made in the Vapi dashboard; without it the secret is sent as a header
Vapi stores). Home Assistant's `secrets.yaml` holds `jarvis_webhook_authorization` (`Bearer <WEBHOOK_SECRET>`).

**Commands**
- `npm run voice:push`: make Vapi match `voice/assistant.json` plus the tool registry (creates or updates the assistant, points the
  number at Jarvis, saves ids in `voice/.vapi-ids.json`). `-- --dry` prints what it would send, secrets hidden. Run it after changing
  a tool, the prompt, the voice or the model. The code is the source of truth, never the Vapi dashboard.
- **Switch it off quickly:** `VOICE_ENABLED=false` and restart: every `/voice` request gets a polite refusal and no alert calls are
  made. Dry/live: edit `VOICE_HA_WRITES` and restart.

## Notes

The dashboard (`GET /`) and `/spotify` are behind Cloudflare Access. `/health`,
`/webhook/*` and `/fridge` (code-locked, see above) are the only public routes; the webhook needs the bearer secret. As a second
check, tunnel requests to `/spotify` are only served if they arrive on `PUBLIC_HOST` and carry
the `Cf-Access-Jwt-Assertion` header. That header is checked for presence only, not verified.
