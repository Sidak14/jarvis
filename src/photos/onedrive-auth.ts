import type Database from "better-sqlite3";
import { MS_LOGIN_BASE, MS_SCOPES, REFRESH_TOKEN_DAYS } from "./settings";

// The Microsoft (personal OneDrive) login: device code flow, so no web redirect is needed. You open a short
// address on any device, type a code, and sign in; Jarvis then holds a refresh token in the database (same
// protection as the Google logins). Tokens are never logged or put in an error message.
// Scopes: Files.ReadWrite (the narrowest Graph scope that can write into a normal folder) + offline_access.

const REFRESH_MARGIN_MS = 120_000;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}
export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message?: string;
}
export class OneDriveAuthError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface AuthStatus {
  configured: boolean;
  connected: boolean;
  needsLogin: boolean;
  lastError: string | null;
  refreshedAt: string | null;
  /** Estimated days left before an UNUSED refresh token would die (it renews every time it is used). */
  daysLeft: number | null;
}

export class OneDriveAuth {
  private refreshing: Promise<string> | null = null;

  constructor(
    private db: Database.Database,
    private clientId: string,
    private fetchFn: typeof fetch = fetch,
    private loginBase = MS_LOGIN_BASE,
    private clock: () => Date = () => new Date(),
  ) {}

  isConfigured(): boolean {
    return Boolean(this.clientId);
  }

  status(): AuthStatus {
    const row = this.row();
    const refreshedAt = row?.refreshed_at ?? null;
    return {
      configured: this.isConfigured(),
      connected: Boolean(row?.refresh_token) && !row?.needs_login,
      needsLogin: Boolean(row?.needs_login),
      lastError: row?.last_error ?? null,
      refreshedAt,
      daysLeft: refreshedAt ? Math.round(REFRESH_TOKEN_DAYS - (this.clock().getTime() - Date.parse(refreshedAt)) / 86_400_000) : null,
    };
  }

  /** Step 1 of signing in: Microsoft gives a code to type at a web address. */
  async startDeviceCode(): Promise<DeviceCode> {
    const body = await this.post("devicecode", { scope: MS_SCOPES.join(" ") });
    return body as unknown as DeviceCode;
  }

  /** Step 2: wait for the sign-in to finish, then keep the tokens. `sleep` is injectable for tests. */
  async finishDeviceCode(dc: DeviceCode, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
    let interval = Math.max(1, dc.interval || 5);
    const deadline = this.clock().getTime() + dc.expires_in * 1000;
    while (this.clock().getTime() < deadline) {
      await sleep(interval * 1000);
      try {
        const body = (await this.post("token", {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: dc.device_code,
        })) as unknown as TokenResponse;
        this.save(body, null);
        return;
      } catch (err) {
        const code = err instanceof OneDriveAuthError ? err.code : "";
        if (code === "authorization_pending") continue;
        if (code === "slow_down") {
          interval += 5;
          continue;
        }
        throw err;
      }
    }
    throw new OneDriveAuthError("expired_token", "The sign-in code expired before it was used. Start again.");
  }

  /** A valid access token, refreshing it when it is about to expire (or when forced: the daily keep-alive). */
  async getAccessToken(forceRefresh = false): Promise<string> {
    const row = this.row();
    if (!row?.refresh_token) throw new OneDriveAuthError("not_connected", "OneDrive is not connected. Run: npm run photos:setup");
    if (row.needs_login) throw new OneDriveAuthError("needs_login", "OneDrive sign-in expired or was revoked. Run: npm run photos:setup");
    if (!forceRefresh && row.access_token && (row.expires_at ?? 0) > this.clock().getTime() + REFRESH_MARGIN_MS) return row.access_token;
    if (!this.refreshing) {
      this.refreshing = this.refresh(row.refresh_token).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async refresh(refreshToken: string): Promise<string> {
    try {
      const body = (await this.post("token", { grant_type: "refresh_token", refresh_token: refreshToken, scope: MS_SCOPES.join(" ") })) as unknown as TokenResponse;
      this.save(body, refreshToken);
      return body.access_token;
    } catch (err) {
      const now = this.clock().toISOString();
      const dead = err instanceof OneDriveAuthError && (err.code === "invalid_grant" || err.code === "interaction_required");
      this.db
        .prepare(`UPDATE onedrive_auth SET needs_login = ?, last_error = ?, updated_at = ? WHERE id = 1`)
        .run(dead ? 1 : 0, (err as Error).message.slice(0, 200), now);
      if (dead) throw new OneDriveAuthError("needs_login", "OneDrive sign-in expired or was revoked. Run: npm run photos:setup");
      throw err;
    }
  }

  private async post(endpoint: "devicecode" | "token", params: Record<string, string>): Promise<Record<string, unknown>> {
    if (!this.isConfigured()) throw new OneDriveAuthError("not_configured", "OneDrive is not configured: set MS_CLIENT_ID in .env");
    const res = await this.fetchFn(`${this.loginBase}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, client_id: this.clientId }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof json.error === "string" ? json.error : `http_${res.status}`;
      // Only the error CODE is kept: the description can echo request details.
      throw new OneDriveAuthError(code, `Microsoft sign-in request failed: ${code}`);
    }
    return json;
  }

  private save(body: TokenResponse, previousRefreshToken: string | null): void {
    const refreshToken = body.refresh_token ?? previousRefreshToken;
    if (!refreshToken) throw new OneDriveAuthError("no_refresh_token", "Microsoft did not return a refresh token (is offline_access granted?)");
    const granted = (body.scope ?? "").toLowerCase().split(" ");
    if (body.scope && !granted.includes("files.readwrite")) throw new OneDriveAuthError("scope", "Microsoft did not grant Files.ReadWrite. Sign in again and accept it.");
    const now = this.clock();
    this.db
      .prepare(
        `INSERT INTO onedrive_auth (id, access_token, refresh_token, expires_at, scope, refreshed_at, needs_login, last_error, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, 0, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at,
           scope = excluded.scope, refreshed_at = excluded.refreshed_at, needs_login = 0, last_error = NULL, updated_at = excluded.updated_at`,
      )
      .run(body.access_token, refreshToken, now.getTime() + body.expires_in * 1000, body.scope ?? null, now.toISOString(), now.toISOString());
  }

  private row() {
    return this.db.prepare(`SELECT access_token, refresh_token, expires_at, refreshed_at, needs_login, last_error FROM onedrive_auth WHERE id = 1`).get() as
      | { access_token: string | null; refresh_token: string | null; expires_at: number | null; refreshed_at: string | null; needs_login: number; last_error: string | null }
      | undefined;
  }
}
