import type Database from "better-sqlite3";
import type { SpotifyAuth } from "./auth";
import { RECENT_LIMIT } from "./settings";
import { recordApiCall } from "./usage";

const API = "https://api.spotify.com/v1";

export interface Play {
  trackId: string;
  playedAt: string; // ISO 8601 UTC
  name: string;
  artists: string;
}

/** The three things Jarvis needs from Spotify. Tests swap in a fake one. */
export interface SpotifyClient {
  recentlyPlayed(): Promise<Play[]>;
  areLiked(trackIds: string[]): Promise<boolean[]>;
  like(trackIds: string[]): Promise<void>;
}

const uri = (trackId: string) => `spotify:track:${trackId}`;
// Commas separate the URIs, so only encode the URIs themselves.
const uriList = (ids: string[]) => ids.map((id) => encodeURIComponent(uri(id))).join(",");

export function createSpotifyClient(
  auth: Pick<SpotifyAuth, "getAccessToken">,
  db: Database.Database,
  log: (message: string) => void,
  fetchFn: typeof fetch = fetch,
): SpotifyClient {
  /** One Spotify call: adds the token, counts it in api_usage, retries once on 401. */
  async function call(method: string, path: string, jsonBody?: unknown): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await auth.getAccessToken(attempt === 1); // 2nd try: force a refresh
      recordApiCall(db);
      const res = await fetchFn(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(jsonBody ? { "Content-Type": "application/json" } : {}),
        },
        body: jsonBody ? JSON.stringify(jsonBody) : undefined,
      });
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 429) {
        const wait = res.headers.get("retry-after") ?? "unknown";
        throw new Error(`Spotify rate limit reached (429). Retry-After: ${wait}s`);
      }
      return res;
    }
    throw new Error("Spotify rejected the access token (401)");
  }

  async function failure(what: string, res: Response): Promise<Error> {
    const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    const detail = json?.error?.message ? `: ${json.error.message}` : "";
    return new Error(`Spotify ${what} failed (HTTP ${res.status})${detail}`);
  }

  return {
    async recentlyPlayed() {
      const res = await call("GET", `/me/player/recently-played?limit=${RECENT_LIMIT}`);
      if (!res.ok) throw await failure("recently-played", res);
      const json = (await res.json()) as {
        items: Array<{
          played_at: string;
          track: {
            id: string | null;
            name: string;
            type?: string;
            is_local?: boolean;
            artists: Array<{ name: string }>;
          } | null;
        }>;
      };
      const plays: Play[] = [];
      for (const item of json.items) {
        const t = item.track;
        // Skip anything we can't like: local files, podcasts, missing tracks.
        if (!t || !t.id || t.is_local || (t.type && t.type !== "track")) continue;
        plays.push({
          trackId: t.id,
          playedAt: new Date(item.played_at).toISOString(),
          name: t.name,
          artists: t.artists.map((a) => a.name).join(", "),
        });
      }
      return plays;
    },

    async areLiked(trackIds) {
      const res = await call("GET", `/me/library/contains?uris=${uriList(trackIds)}`);
      if (!res.ok) throw await failure("library check", res);
      const flags = (await res.json()) as boolean[];
      if (!Array.isArray(flags) || flags.length !== trackIds.length) {
        throw new Error("Spotify library check returned an unexpected answer");
      }
      return flags;
    },

    async like(trackIds) {
      let res = await call("PUT", `/me/library?uris=${uriList(trackIds)}`);
      if (res.status === 400) {
        // Spotify's docs disagree on whether uris go in the query or a JSON body.
        log("like with query string got 400, retrying with a JSON body");
        res = await call("PUT", "/me/library", { uris: trackIds.map(uri) });
      }
      if (!res.ok) throw await failure("like", res);
    },
  };
}
