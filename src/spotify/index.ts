import { config } from "../config";
import { db } from "../db";
import { SpotifyAuth } from "./auth";

/** The one shared Spotify login for the whole server. */
export const spotifyAuth = new SpotifyAuth(
  db,
  config.SPOTIFY_CLIENT_ID ?? "",
  config.SPOTIFY_CLIENT_SECRET ?? "",
  config.SPOTIFY_REDIRECT_URI,
);
