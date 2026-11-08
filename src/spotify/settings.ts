// All the knobs for the Spotify module live here. Change a number, rebuild, restart.

/** Like a track once it has MORE than this many plays in the window (so 5 or more). */
export const PLAY_THRESHOLD = 4;

/** How far back (in days) plays count towards the threshold. */
export const WINDOW_DAYS = 2;

/** How often the job runs. Every 2 hours, on the hour. */
export const POLL_CRON = "0 */2 * * *";

/** Spotify returns at most 50 recent plays per request. */
export const RECENT_LIMIT = 50;

/** Spotify accepts at most 40 URIs per library call. */
export const LIKE_BATCH = 40;

/** Name used in the jobs table, the status page and the webhook. */
export const JOB_NAME = "spotify-likes";

export const SCOPES = [
  "user-read-recently-played", // read what I played
  "user-library-read", // check if a track is already liked
  "user-library-modify", // like tracks
];
