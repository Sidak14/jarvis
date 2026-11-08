import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { SpotifyAuth } from "./auth";
import { createSpotifyTables } from "./schema";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("SpotifyAuth", () => {
  let db: Database.Database;
  let requests: { url: string; body: string; authorization: string }[];
  let queue: Response[];

  const fetchFn = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    requests.push({ url, body: String(init.body), authorization: headers.Authorization });
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra request");
    return next;
  }) as unknown as typeof fetch;

  const LOCAL_URI = "http://127.0.0.1:8080/spotify/callback";
  const makeAuth = (redirectUri = LOCAL_URI) =>
    new SpotifyAuth(db, "client-id", "client-secret", redirectUri, fetchFn);
  const seedToken = (expiresInMs: number) =>
    db
      .prepare(`INSERT INTO spotify_auth VALUES (1, 'old-access', 'old-refresh', ?, NULL, 'x')`)
      .run(Date.now() + expiresInMs);
  const stored = () =>
    db.prepare(`SELECT access_token, refresh_token FROM spotify_auth WHERE id = 1`).get() as
      | { access_token: string; refresh_token: string }
      | undefined;

  beforeEach(() => {
    db = new Database(":memory:");
    createSpotifyTables(db);
    requests = [];
    queue = [];
  });

  it("throws a helpful message when not logged in", async () => {
    await assert.rejects(makeAuth().getAccessToken(), /not connected.*\/spotify\/login/);
  });

  it("builds the login URL with the redirect URI and scopes", () => {
    const url = new URL(makeAuth().authorizeUrl("abc"));
    assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:8080/spotify/callback");
    assert.equal(url.searchParams.get("state"), "abc");
    assert.equal(
      url.searchParams.get("scope"),
      "user-read-recently-played user-library-read user-library-modify",
    );
  });

  it("uses the configured redirect URI for the login URL and the token exchange", async () => {
    const publicUri = "https://jarvis.gurveerkhalsa.com/spotify/callback";
    const auth = makeAuth(publicUri);
    assert.equal(new URL(auth.authorizeUrl("s")).searchParams.get("redirect_uri"), publicUri);
    assert.equal(auth.loginUrl(), "https://jarvis.gurveerkhalsa.com/spotify/login");
    queue.push(json({ access_token: "A1", refresh_token: "R1", expires_in: 3600 }));
    await auth.exchangeCode("c");
    assert.match(requests[0].body, /redirect_uri=https%3A%2F%2Fjarvis\.gurveerkhalsa\.com%2Fspotify%2Fcallback/);
  });

  it("exchanges a code for tokens and stores them", async () => {
    queue.push(json({ access_token: "A1", refresh_token: "R1", expires_in: 3600, scope: "s" }));
    await makeAuth().exchangeCode("the-code");
    assert.deepEqual(stored(), { access_token: "A1", refresh_token: "R1" });
    assert.match(requests[0].body, /grant_type=authorization_code/);
    assert.match(requests[0].body, /code=the-code/);
    assert.equal(
      requests[0].authorization,
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
  });

  it("returns the stored token without calling Spotify while it is still valid", async () => {
    seedToken(10 * 60 * 1000);
    assert.equal(await makeAuth().getAccessToken(), "old-access");
    assert.equal(requests.length, 0);
  });

  it("refreshes an expired token and keeps the old refresh token when none is returned", async () => {
    seedToken(-1000);
    queue.push(json({ access_token: "A2", expires_in: 3600 }));
    assert.equal(await makeAuth().getAccessToken(), "A2");
    assert.deepEqual(stored(), { access_token: "A2", refresh_token: "old-refresh" });
    assert.match(requests[0].body, /grant_type=refresh_token/);
  });

  it("refreshes a token that is about to expire (inside the 60 second margin)", async () => {
    seedToken(30_000);
    queue.push(json({ access_token: "A2", expires_in: 3600 }));
    assert.equal(await makeAuth().getAccessToken(), "A2");
  });

  it("saves a new refresh token when Spotify rotates it", async () => {
    seedToken(-1000);
    queue.push(json({ access_token: "A2", refresh_token: "R2", expires_in: 3600 }));
    await makeAuth().getAccessToken();
    assert.deepEqual(stored(), { access_token: "A2", refresh_token: "R2" });
  });

  it("shares one refresh request between simultaneous callers", async () => {
    seedToken(-1000);
    queue.push(json({ access_token: "A2", expires_in: 3600 }));
    const auth = makeAuth();
    const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);
    assert.equal(a, "A2");
    assert.equal(b, "A2");
    assert.equal(requests.length, 1);
  });

  it("clears the login and asks for a new one on invalid_grant", async () => {
    seedToken(-1000);
    queue.push(json({ error: "invalid_grant" }, 400));
    await assert.rejects(makeAuth().getAccessToken(), /Log in again at .*\/spotify\/login/);
    assert.equal(stored(), undefined);
  });

  it("never puts tokens or the client secret in error messages", async () => {
    seedToken(-1000);
    queue.push(json({ error: "server_error" }, 500));
    await assert.rejects(makeAuth().getAccessToken(), (err: Error) => {
      return !/old-refresh|old-access|client-secret/.test(err.message);
    });
  });
});
