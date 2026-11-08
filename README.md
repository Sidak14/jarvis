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

## Notes

The dashboard (`GET /`) and `/spotify` are behind Cloudflare Access. `/health` and
`/webhook/*` are the only public routes; the webhook needs the bearer secret. As a second
check, tunnel requests to `/spotify` are only served if they arrive on `PUBLIC_HOST` and carry
the `Cf-Access-Jwt-Assertion` header. That header is checked for presence only, not verified.
