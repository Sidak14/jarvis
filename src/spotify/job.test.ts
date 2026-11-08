import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { Play, SpotifyClient } from "./client";
import { runSpotifyLikes } from "./job";
import { createSpotifyTables } from "./schema";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

/** n plays of one track, the most recent `startHoursAgo` hours before NOW, one hour apart. */
function plays(trackId: string, n: number, startHoursAgo = 1): Play[] {
  return Array.from({ length: n }, (_, i) => ({
    trackId,
    playedAt: new Date(NOW.getTime() - (startHoursAgo + i) * HOUR).toISOString(),
    name: `Song ${trackId}`,
    artists: "Test Artist",
  }));
}

/** A fake Spotify: returns the plays we give it and remembers what was liked. */
function fakeClient(recent: Play[], alreadyLiked: string[] = []) {
  const spotifyLikes = new Set(alreadyLiked);
  const likeCalls: string[][] = [];
  const client: SpotifyClient = {
    recentlyPlayed: async () => recent,
    areLiked: async (ids) => ids.map((id) => spotifyLikes.has(id)),
    like: async (ids) => {
      likeCalls.push(ids);
      ids.forEach((id) => spotifyLikes.add(id));
    },
  };
  return { client, likeCalls, spotifyLikes };
}

describe("runSpotifyLikes", () => {
  let db: Database.Database;
  let logs: string[];
  const log = (m: string) => logs.push(m);

  beforeEach(() => {
    db = new Database(":memory:");
    createSpotifyTables(db);
    logs = [];
  });

  const run = (client: SpotifyClient, dryRun = false) =>
    runSpotifyLikes({ db, client, dryRun, log, now: NOW });
  const likeRows = () => db.prepare(`SELECT track_id, source FROM likes ORDER BY track_id`).all();

  it("likes a track played 5 times in the window", async () => {
    const f = fakeClient(plays("a", 5));
    const r = await run(f.client);
    assert.deepEqual(r.liked, ["a"]);
    assert.deepEqual(f.likeCalls, [["a"]]);
    assert.deepEqual(likeRows(), [{ track_id: "a", source: "jarvis" }]);
  });

  it("does not like a track played only 4 times", async () => {
    const f = fakeClient(plays("a", 4));
    const r = await run(f.client);
    assert.deepEqual(r.liked, []);
    assert.equal(f.likeCalls.length, 0);
  });

  it("only counts plays inside the 2 day window", async () => {
    // 3 recent plays + 2 plays 3 days ago already stored: only 3 count.
    const old = plays("a", 2, 72);
    const insert = db.prepare(`INSERT INTO play_history VALUES (?, ?, ?, ?)`);
    old.forEach((p) => insert.run(p.trackId, p.playedAt, p.name, p.artists));
    const f = fakeClient(plays("a", 3));
    const r = await run(f.client);
    assert.deepEqual(r.liked, []);
  });

  it("builds counts across polls, and overlapping polls do not double count", async () => {
    await run(fakeClient(plays("a", 3, 10)).client); // first poll: 3 plays, not enough
    const second = plays("a", 3, 10).concat(plays("a", 2, 1)); // overlaps the first, plus 2 new
    const f = fakeClient(second);
    const r = await run(f.client);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM play_history`).get() as { n: number };
    assert.equal(count.n, 5); // 5 distinct plays, not 8
    assert.equal(r.newPlays, 2);
    assert.deepEqual(r.liked, ["a"]);
  });

  it("never likes the same track twice across reruns", async () => {
    const f = fakeClient(plays("a", 5));
    await run(f.client);
    await run(f.client);
    await run(f.client);
    assert.equal(f.likeCalls.length, 1);
  });

  it("does not re-like a track the user un-liked later", async () => {
    const f = fakeClient(plays("a", 5));
    await run(f.client);
    f.spotifyLikes.delete("a"); // user taps the heart off
    await run(f.client);
    assert.equal(f.likeCalls.length, 1);
  });

  it("skips tracks that are already liked and records them as existing", async () => {
    const f = fakeClient(plays("a", 5), ["a"]);
    const r = await run(f.client);
    assert.deepEqual(r.alreadyLiked, ["a"]);
    assert.equal(f.likeCalls.length, 0);
    assert.deepEqual(likeRows(), [{ track_id: "a", source: "existing" }]);
  });

  it("dry run logs what it would like and changes nothing", async () => {
    const f = fakeClient(plays("a", 5));
    const r = await run(f.client, true);
    assert.deepEqual(r.wouldLike, ["a"]);
    assert.equal(f.likeCalls.length, 0);
    assert.deepEqual(likeRows(), []);
    assert.ok(logs.some((l) => l.startsWith("WOULD like: Song a")));
  });

  it("likes in batches of 40", async () => {
    const many = Array.from({ length: 45 }, (_, i) => plays(`t${String(i).padStart(2, "0")}`, 5)).flat();
    const f = fakeClient(many);
    await run(f.client);
    assert.deepEqual(f.likeCalls.map((c) => c.length), [40, 5]);
  });

  it("saves liked status for the dashboard", async () => {
    const f = fakeClient([...plays("a", 1), ...plays("b", 1)], ["b"]);
    await run(f.client);
    const rows = db.prepare(`SELECT track_id, is_liked FROM track_status ORDER BY track_id`).all();
    assert.deepEqual(rows, [
      { track_id: "a", is_liked: 0 },
      { track_id: "b", is_liked: 1 },
    ]);
  });

  it("lets a Spotify error through so the runner can record a failure", async () => {
    const client: SpotifyClient = {
      recentlyPlayed: async () => {
        throw new Error("boom");
      },
      areLiked: async () => [],
      like: async () => {},
    };
    await assert.rejects(run(client), /boom/);
  });
});
