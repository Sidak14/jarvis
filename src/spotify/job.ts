import type Database from "better-sqlite3";
import type { SpotifyClient } from "./client";
import { LIKE_BATCH, PLAY_THRESHOLD, WINDOW_DAYS } from "./settings";

export interface SpotifyLikesDeps {
  db: Database.Database;
  client: SpotifyClient;
  dryRun: boolean;
  log: (message: string) => void;
  now?: Date; // injectable so tests can control "today"
}

export interface SpotifyLikesResult {
  newPlays: number;
  liked: string[]; // track ids we liked this run
  wouldLike: string[]; // dry run only
  alreadyLiked: string[]; // were already liked on Spotify
}

interface Candidate {
  track_id: string;
  name: string;
  artists: string;
  plays: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One pass: store new plays, then like anything played more than PLAY_THRESHOLD times. */
export async function runSpotifyLikes(deps: SpotifyLikesDeps): Promise<SpotifyLikesResult> {
  const { db, client, dryRun, log } = deps;
  const now = deps.now ?? new Date();
  const result: SpotifyLikesResult = { newPlays: 0, liked: [], wouldLike: [], alreadyLiked: [] };

  // 1. Fetch my last 50 plays and store the new ones.
  //    (track_id, played_at) is the primary key, so plays we already have are ignored.
  const plays = await client.recentlyPlayed();
  const insertPlay = db.prepare(
    `INSERT OR IGNORE INTO play_history (track_id, played_at, track_name, artists)
     VALUES (?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const p of plays) {
      result.newPlays += insertPlay.run(p.trackId, p.playedAt, p.name, p.artists).changes;
    }
  })();
  log(`Fetched ${plays.length} recent plays, ${result.newPlays} new`);

  // 2. Count plays per track over the rolling window; keep tracks over the threshold.
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const candidates = db
    .prepare(
      `SELECT track_id, MAX(track_name) AS name, MAX(artists) AS artists, COUNT(*) AS plays
         FROM play_history
        WHERE played_at >= ?
        GROUP BY track_id
       HAVING COUNT(*) > ?
        ORDER BY plays DESC`,
    )
    .all(windowStart, PLAY_THRESHOLD) as Candidate[];
  log(
    `${candidates.length} track(s) played more than ${PLAY_THRESHOLD} times in the last ${WINDOW_DAYS} days`,
  );

  // 3. Ask Spotify which of these (and my recent plays) are already liked.
  //    The answers are saved so the dashboard can show liked / not liked.
  const toCheck = [...new Set([...plays.map((p) => p.trackId), ...candidates.map((c) => c.track_id)])];
  const isLiked = new Map<string, boolean>();
  const saveStatus = db.prepare(
    `INSERT INTO track_status (track_id, is_liked, checked_at) VALUES (?, ?, ?)
     ON CONFLICT(track_id) DO UPDATE SET is_liked = excluded.is_liked, checked_at = excluded.checked_at`,
  );
  for (const batch of chunk(toCheck, LIKE_BATCH)) {
    const flags = await client.areLiked(batch);
    batch.forEach((id, i) => {
      isLiked.set(id, flags[i]);
      saveStatus.run(id, flags[i] ? 1 : 0, now.toISOString());
    });
  }

  // 4. Decide what to like.
  const alreadyDealtWith = db.prepare(`SELECT 1 FROM likes WHERE track_id = ?`);
  const recordLike = db.prepare(
    `INSERT OR IGNORE INTO likes (track_id, track_name, liked_at, source) VALUES (?, ?, ?, ?)`,
  );
  const toLike: Candidate[] = [];
  for (const c of candidates) {
    const label = `${c.name} - ${c.artists} (${c.plays} plays)`;
    if (alreadyDealtWith.get(c.track_id)) continue; // never like (or re-like) the same track twice
    if (isLiked.get(c.track_id)) {
      log(`already liked: ${label}`);
      result.alreadyLiked.push(c.track_id);
      if (!dryRun) recordLike.run(c.track_id, c.name, now.toISOString(), "existing");
      continue;
    }
    toLike.push(c);
  }

  if (dryRun) {
    for (const c of toLike) {
      log(`WOULD like: ${c.name} - ${c.artists} (${c.plays} plays)`);
      result.wouldLike.push(c.track_id);
    }
  } else {
    for (const batch of chunk(toLike, LIKE_BATCH)) {
      await client.like(batch.map((c) => c.track_id));
      db.transaction(() => {
        for (const c of batch) {
          recordLike.run(c.track_id, c.name, now.toISOString(), "jarvis");
          saveStatus.run(c.track_id, 1, now.toISOString());
          log(`liked: ${c.name} - ${c.artists} (${c.plays} plays)`);
          result.liked.push(c.track_id);
        }
      })();
    }
  }

  log(
    `Done: ${result.liked.length} liked, ${result.wouldLike.length} would like (dry run), ` +
      `${result.alreadyLiked.length} already liked`,
  );
  return result;
}
