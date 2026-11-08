import { config } from "../config";
import { db } from "../db";
import { registerJob } from "../runner";
import { createSpotifyClient } from "../spotify/client";
import { spotifyAuth } from "../spotify";
import { runSpotifyLikes } from "../spotify/job";
import { JOB_NAME, POLL_CRON } from "../spotify/settings";

export function registerSpotifyLikes(): void {
  registerJob(JOB_NAME, POLL_CRON, async ({ log }) => {
    if (!spotifyAuth.isConfigured()) {
      throw new Error(
        "Spotify is not configured: set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env, then restart",
      );
    }
    log(
      config.SPOTIFY_DRY_RUN
        ? "DRY RUN: nothing will be liked, only logged"
        : "LIVE: tracks over the threshold will be liked",
    );
    const client = createSpotifyClient(spotifyAuth, db, log);
    await runSpotifyLikes({ db, client, dryRun: config.SPOTIFY_DRY_RUN, log });
  });
}
