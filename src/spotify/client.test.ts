import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { createSpotifyClient } from "./client";
import { apiCallsToday } from "./usage";

interface Call {
  method: string;
  url: string;
  body?: string;
  authorization?: string;
}

/** A fake fetch that returns queued responses and records every request. */
function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      method: String(init.method),
      url: String(url),
      body: init.body as string | undefined,
      authorization: headers.Authorization,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return next;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("Spotify client", () => {
  let db: Database.Database;
  const forced: boolean[] = [];
  const auth = {
    getAccessToken: async (force = false) => {
      forced.push(force);
      return force ? "refreshed-token" : "token-1";
    },
  };

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`CREATE TABLE api_usage (provider TEXT NOT NULL, date TEXT NOT NULL,
             units_used INTEGER NOT NULL DEFAULT 0, limit_units INTEGER, PRIMARY KEY (provider, date))`);
    forced.length = 0;
  });

  it("reads recent plays, skipping local files and podcasts, and counts the API call", async () => {
    const { fetchFn, calls } = fakeFetch([
      json({
        items: [
          { played_at: "2026-11-08T10:00:00.000Z", track: { id: "t1", name: "One", type: "track", artists: [{ name: "A" }, { name: "B" }] } },
          { played_at: "2026-11-08T09:00:00Z", track: { id: null, name: "Local", is_local: true, artists: [] } },
          { played_at: "2026-11-08T08:00:00Z", track: { id: "ep1", name: "Podcast", type: "episode", artists: [] } },
          { played_at: "2026-11-08T07:00:00Z", track: null },
        ],
      }),
    ]);
    const plays = await createSpotifyClient(auth, db, () => {}, fetchFn).recentlyPlayed();
    assert.deepEqual(plays, [
      { trackId: "t1", playedAt: "2026-11-08T10:00:00.000Z", name: "One", artists: "A, B" },
    ]);
    assert.equal(calls[0].url, "https://api.spotify.com/v1/me/player/recently-played?limit=50");
    assert.equal(calls[0].authorization, "Bearer token-1");
    assert.equal(apiCallsToday(db), 1);
  });

  it("checks liked status with comma-separated track URIs", async () => {
    const { fetchFn, calls } = fakeFetch([json([true, false])]);
    const flags = await createSpotifyClient(auth, db, () => {}, fetchFn).areLiked(["a", "b"]);
    assert.deepEqual(flags, [true, false]);
    assert.equal(
      calls[0].url,
      "https://api.spotify.com/v1/me/library/contains?uris=spotify%3Atrack%3Aa,spotify%3Atrack%3Ab",
    );
  });

  it("likes with PUT /me/library and the uris in the query", async () => {
    const { fetchFn, calls } = fakeFetch([new Response(null, { status: 200 })]);
    await createSpotifyClient(auth, db, () => {}, fetchFn).like(["a"]);
    assert.equal(calls[0].method, "PUT");
    assert.equal(calls[0].url, "https://api.spotify.com/v1/me/library?uris=spotify%3Atrack%3Aa");
  });

  it("falls back to a JSON body if the query form gets a 400", async () => {
    const logs: string[] = [];
    const { fetchFn, calls } = fakeFetch([json({ error: { status: 400, message: "bad" } }, 400), new Response(null, { status: 200 })]);
    await createSpotifyClient(auth, db, (m) => logs.push(m), fetchFn).like(["a"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, "https://api.spotify.com/v1/me/library");
    assert.equal(calls[1].body, JSON.stringify({ uris: ["spotify:track:a"] }));
    assert.ok(logs.some((l) => l.includes("retrying with a JSON body")));
  });

  it("retries once with a refreshed token after a 401", async () => {
    const { fetchFn, calls } = fakeFetch([json({}, 401), json([true])]);
    await createSpotifyClient(auth, db, () => {}, fetchFn).areLiked(["a"]);
    assert.deepEqual(forced, [false, true]);
    assert.equal(calls[1].authorization, "Bearer refreshed-token");
    assert.equal(apiCallsToday(db), 2);
  });

  it("reports a 429 with the Retry-After value", async () => {
    const { fetchFn } = fakeFetch([json({}, 429, { "retry-after": "30" })]);
    await assert.rejects(
      createSpotifyClient(auth, db, () => {}, fetchFn).recentlyPlayed(),
      /429.*Retry-After: 30s/,
    );
  });

  it("includes Spotify's error message for other failures, never the token", async () => {
    const { fetchFn } = fakeFetch([json({ error: { status: 403, message: "Forbidden for this user" } }, 403)]);
    await assert.rejects(
      createSpotifyClient(auth, db, () => {}, fetchFn).recentlyPlayed(),
      (err: Error) => err.message.includes("HTTP 403") && !err.message.includes("token-1"),
    );
  });
});
