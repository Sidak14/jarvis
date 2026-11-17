import { z } from "zod";
import { PLAY_THRESHOLD, WINDOW_DAYS } from "../../spotify/settings";
import { defineTool } from "../registry";
import { quoted } from "../sanitize";
import { listSpoken, words } from "../speak";
import type { ToolDeps } from "./deps";

/** The last songs played and liked, and which ones are closing in on an automatic like (5 plays in 2 days). */
export const spotifyRecent = (deps: ToolDeps) =>
  defineTool({
    name: "spotify_recent",
    description: "The last five different songs I played and liked on Spotify, and which songs are close to being liked automatically (five plays in two days).",
    schema: z.object({}),
    risk: "read",
    timeoutMs: 4000,
    handler: (_args, ctx) => {
      const song = (r: { name: string; artists: string }) => `${quoted(r.name, 50)} by ${quoted(r.artists, 40).slice(1, -1)}`;
      const plays = deps.db.prepare(`SELECT MAX(track_name) AS name, MAX(artists) AS artists FROM play_history GROUP BY track_id ORDER BY MAX(played_at) DESC LIMIT 5`).all() as { name: string; artists: string }[];
      const likes = deps.db.prepare(`SELECT track_name AS name FROM likes WHERE source = 'jarvis' ORDER BY liked_at DESC LIMIT 5`).all() as { name: string }[];
      const since = new Date(ctx.now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
      const close = deps.db
        .prepare(
          `SELECT MAX(track_name) AS name, MAX(artists) AS artists, COUNT(*) AS plays FROM play_history
            WHERE played_at >= ? AND track_id NOT IN (SELECT track_id FROM likes)
            GROUP BY track_id HAVING plays >= 2 ORDER BY plays DESC LIMIT 3`,
        )
        .all(since) as { name: string; artists: string; plays: number }[];
      const needed = PLAY_THRESHOLD + 1;
      if (plays.length === 0 && likes.length === 0) return { speech: "I haven't seen any Spotify plays yet.", data: { plays: [], likes: [] } };
      const parts = [
        plays.length ? `Latest plays: ${listSpoken(plays.map(song))}.` : "",
        likes.length ? `Last liked: ${listSpoken(likes.map((l) => quoted(l.name, 50)), 2)}.` : "",
        close.length ? `Closest to a like: ${quoted(close[0].name, 50)} with ${words(close[0].plays)} of ${words(needed)} plays.` : "",
      ].filter(Boolean);
      return {
        speech: `${parts.join(" ")}${plays.length > 3 ? " Want the rest?" : ""}`,
        data: { plays, liked_by_jarvis: likes, close_to_like: close.map((c) => ({ name: c.name, plays: c.plays, needed })) },
      };
    },
  });
