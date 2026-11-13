import { JOB_NAME, PLAY_THRESHOLD, POLL_CRON, WINDOW_DAYS } from "../../spotify/settings";
import { apiCallsToday } from "../../spotify/usage";
import { scheduleToWords } from "../format";
import type { UiContext } from "./types";

// The Spotify page: tiles, the recently-played table (with progress toward the like threshold) and a run's output.

export type LikedState = "jarvis" | "liked" | "due" | "not" | "unknown";

export interface TrackVM {
  id: string;
  name: string;
  artists: string;
  lastPlayed: Date;
  playsInWindow: number;
  playsTotal: number;
  liked: LikedState;
}
export interface SpotifyRunVM {
  id: number;
  status: string;
  startedAt: Date;
  durationMs: number | null;
  log: string;
}
export interface SpotifyVM {
  configured: boolean;
  connected: boolean;
  dryRun: boolean;
  /** Plays needed to like a song ("more than 4" = 5). */
  threshold: number;
  windowDays: number;
  ruleText: string;
  scheduleText: string;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  likesThisWeek: number;
  apiCallsToday: number;
  tracks: TrackVM[];
  run: SpotifyRunVM | null;
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

export function likedState(t: { is_liked: number | null; like_source: string | null; plays_in_window: number }): LikedState {
  if (t.like_source === "jarvis") return "jarvis";
  if (t.is_liked === 1) return "liked";
  if (t.is_liked === 0) return t.plays_in_window > PLAY_THRESHOLD ? "due" : "not";
  return "unknown";
}

export function buildSpotify(ctx: UiContext, runId?: number): SpotifyVM {
  const { db, now, flags } = ctx;
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const tracks = db
    .prepare(
      `SELECT p.track_id, MAX(p.track_name) AS name, MAX(p.artists) AS artists, MAX(p.played_at) AS last_played,
              SUM(CASE WHEN p.played_at >= ? THEN 1 ELSE 0 END) AS plays_in_window, COUNT(*) AS plays_total,
              s.is_liked AS is_liked, l.source AS like_source
         FROM play_history p
         LEFT JOIN track_status s ON s.track_id = p.track_id
         LEFT JOIN likes l ON l.track_id = p.track_id
        GROUP BY p.track_id ORDER BY last_played DESC LIMIT 50`,
    )
    .all(windowStart) as TrackRow[];
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const likes = (db.prepare(`SELECT COUNT(*) AS n FROM likes WHERE source = 'jarvis' AND liked_at >= ?`).get(weekAgo) as { n: number }).n;
  const job = db.prepare(`SELECT last_run_at, next_run_at FROM jobs WHERE name = ?`).get(JOB_NAME) as { last_run_at: string | null; next_run_at: string | null } | undefined;
  const run = (
    runId && Number.isInteger(runId) && runId > 0
      ? db.prepare(`SELECT * FROM runs WHERE id = ? AND job = ?`).get(runId, JOB_NAME)
      : db.prepare(`SELECT * FROM runs WHERE job = ? ORDER BY id DESC LIMIT 1`).get(JOB_NAME)
  ) as { id: number; status: string; started_at: string; duration_ms: number | null; log: string | null } | undefined;

  return {
    configured: flags.spotifyConfigured,
    connected: flags.spotifyConnected,
    dryRun: flags.spotifyDryRun,
    threshold: PLAY_THRESHOLD + 1,
    windowDays: WINDOW_DAYS,
    ruleText: `${PLAY_THRESHOLD + 1} plays in ${WINDOW_DAYS} days`,
    scheduleText: scheduleToWords(POLL_CRON),
    nextRunAt: job?.next_run_at ? new Date(job.next_run_at) : null,
    lastRunAt: job?.last_run_at ? new Date(job.last_run_at) : null,
    likesThisWeek: likes,
    apiCallsToday: apiCallsToday(db),
    tracks: tracks.map((t) => ({
      id: t.track_id,
      name: t.name,
      artists: t.artists,
      lastPlayed: new Date(t.last_played),
      playsInWindow: t.plays_in_window,
      playsTotal: t.plays_total,
      liked: likedState(t),
    })),
    run: run ? { id: run.id, status: run.status, startedAt: new Date(run.started_at), durationMs: run.duration_ms, log: run.log ?? "" } : null,
  };
}

