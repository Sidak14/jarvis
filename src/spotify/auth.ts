import type Database from "better-sqlite3";
import { SCOPES } from "./settings";

const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

/** Refresh a little early so a token never expires in the middle of a request. */
const REFRESH_MARGIN_MS = 60_000;

interface TokenRow {
  access_token: string;
  refresh_token: string;
  expires_at: number; // ms since epoch
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string; // Spotify may or may not send a new one on refresh
  expires_in: number; // seconds
  scope?: string;
}

class SpotifyAuthError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Handles the Spotify login: builds the login URL, swaps the code for tokens,
 * stores them in SQLite, and refreshes the access token when it runs out.
 * Tokens are never logged or put in error messages.
 */
export class SpotifyAuth {
  private refreshing: Promise<string> | null = null;

  constructor(
    private db: Database.Database,
    private clientId: string,
    private clientSecret: string,
    private redirectUri: string, // must match the one registered with Spotify exactly
    private fetchFn: typeof fetch = fetch,
  ) {}

  /** Where to start a login: same host as the redirect URI, so the browser stays on one site. */
  loginUrl(): string {
    return new URL("/spotify/login", this.redirectUri).toString();
  }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  isConnected(): boolean {
    return this.row() !== undefined;
  }

  /** Step 1 of login: where to send the browser. */
  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: "code",
      redirect_uri: this.redirectUri,
      scope: SCOPES.join(" "),
      state,
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  /** Step 2 of login: swap the one-time code for tokens and save them. */
  async exchangeCode(code: string): Promise<void> {
    const body = await this.requestToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
    });
    this.save(body, null);
  }

  /** Returns a valid access token, refreshing it first if it is (nearly) expired. */
  async getAccessToken(forceRefresh = false): Promise<string> {
    const row = this.row();
    if (!row) {
      throw new Error(`Spotify is not connected. Log in at ${this.loginUrl()}`);
    }
    if (!forceRefresh && row.expires_at > Date.now() + REFRESH_MARGIN_MS) {
      return row.access_token;
    }
    // If two calls need a refresh at once, they share one request.
    if (!this.refreshing) {
      this.refreshing = this.refresh(row).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async refresh(row: TokenRow): Promise<string> {
    let body: TokenResponse;
    try {
      body = await this.requestToken({
        grant_type: "refresh_token",
        refresh_token: row.refresh_token,
      });
    } catch (err) {
      if (err instanceof SpotifyAuthError && err.code === "invalid_grant") {
        // The refresh token expired (about 6 months) or access was revoked.
        this.db.prepare(`DELETE FROM spotify_auth`).run();
        throw new Error(`Spotify login expired or was revoked. Log in again at ${this.loginUrl()}`);
      }
      throw err;
    }
    // Keep the old refresh token if Spotify didn't send a new one.
    this.save(body, row.refresh_token);
    return body.access_token;
  }

  private async requestToken(params: Record<string, string>): Promise<TokenResponse> {
    if (!this.isConfigured()) {
      throw new Error("Spotify is not configured: set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env");
    }
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const res = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof json.error === "string" ? json.error : `http_${res.status}`;
      throw new SpotifyAuthError(code, `Spotify token request failed: ${code}`);
    }
    return json as unknown as TokenResponse;
  }

  private save(body: TokenResponse, previousRefreshToken: string | null): void {
    const refreshToken = body.refresh_token ?? previousRefreshToken;
    if (!refreshToken) throw new Error("Spotify did not return a refresh token");
    this.db
      .prepare(
        `INSERT INTO spotify_auth (id, access_token, refresh_token, expires_at, scope, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           updated_at = excluded.updated_at`,
      )
      .run(
        body.access_token,
        refreshToken,
        Date.now() + body.expires_in * 1000,
        body.scope ?? null,
        new Date().toISOString(),
      );
  }

  private row(): TokenRow | undefined {
    return this.db
      .prepare(`SELECT access_token, refresh_token, expires_at FROM spotify_auth WHERE id = 1`)
      .get() as TokenRow | undefined;
  }
}
