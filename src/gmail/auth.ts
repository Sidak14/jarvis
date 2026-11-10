import type Database from "better-sqlite3";
import { SCOPES } from "./settings";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REFRESH_MARGIN_MS = 60_000;

interface TokenRow {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

class GoogleAuthError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/**
 * The Gmail login (read-only). Same shape as SpotifyAuth: build the login URL, swap the code for
 * tokens, keep them in SQLite, refresh when needed. Tokens are never logged or put in errors.
 */
export class GmailAuth {
  private refreshing: Promise<string> | null = null;

  constructor(
    private db: Database.Database,
    private clientId: string,
    private clientSecret: string,
    private redirectUri: string, // must match one registered in Google Cloud exactly
    private fetchFn: typeof fetch = fetch,
  ) {}

  loginUrl(): string {
    return new URL("/gmail/login", this.redirectUri).toString();
  }
  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }
  isConnected(): boolean {
    return this.row() !== undefined;
  }

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline", // so Google gives us a refresh token
      prompt: "consent", // and gives it again on every login
      state,
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  async exchangeCode(code: string): Promise<void> {
    const body = await this.requestToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
    });
    this.save(body, null);
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    const row = this.row();
    if (!row) throw new Error(`Gmail is not connected. Log in at ${this.loginUrl()}`);
    if (!forceRefresh && row.expires_at > Date.now() + REFRESH_MARGIN_MS) return row.access_token;
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
      body = await this.requestToken({ grant_type: "refresh_token", refresh_token: row.refresh_token });
    } catch (err) {
      if (err instanceof GoogleAuthError && err.code === "invalid_grant") {
        // Revoked, or expired (Google expires refresh tokens after 7 days while the OAuth app is in "Testing").
        this.db.prepare(`DELETE FROM gmail_auth`).run();
        throw new Error(`Gmail login expired or was revoked. Log in again at ${this.loginUrl()}`);
      }
      throw err;
    }
    this.save(body, row.refresh_token);
    return body.access_token;
  }

  private async requestToken(params: Record<string, string>): Promise<TokenResponse> {
    if (!this.isConfigured()) {
      throw new Error("Gmail is not configured: set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env");
    }
    const res = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, client_id: this.clientId, client_secret: this.clientSecret }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof json.error === "string" ? json.error : `http_${res.status}`;
      throw new GoogleAuthError(code, `Google token request failed: ${code}`);
    }
    return json as unknown as TokenResponse;
  }

  private save(body: TokenResponse, previousRefreshToken: string | null): void {
    const refreshToken = body.refresh_token ?? previousRefreshToken;
    if (!refreshToken) throw new Error("Google did not return a refresh token");
    this.db
      .prepare(
        `INSERT INTO gmail_auth (id, access_token, refresh_token, expires_at, scope, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           updated_at = excluded.updated_at`,
      )
      .run(body.access_token, refreshToken, Date.now() + body.expires_in * 1000, body.scope ?? null, new Date().toISOString());
  }

  private row(): TokenRow | undefined {
    return this.db
      .prepare(`SELECT access_token, refresh_token, expires_at FROM gmail_auth WHERE id = 1`)
      .get() as TokenRow | undefined;
  }
}
