import { createSign } from "node:crypto";
import fs from "node:fs";

// Minimal Google Sheets client: a service account signs a JWT, trades it for an access
// token, then we read/append with plain fetch. No Google library needed.

export interface SheetsClient {
  /** Row number of the Sheet row whose column F equals `marker`, or null. */
  findRow(marker: string): Promise<number | null>;
  /** Append one row (columns A-G). Returns the row number it landed on, if Google says. */
  appendRow(values: (string | number)[]): Promise<number | null>;
  /** Replace the merchant (column B) of an existing row. */
  setMerchant(row: number, merchant: string): Promise<void>;
}

/** fatal = retrying right away will not help (bad auth, network down, Google erroring). */
export class SheetsError extends Error {
  constructor(message: string, public fatal = true) {
    super(message);
  }
}

export interface GoogleSheetsOptions {
  sheetId: string;
  tab: string;
  keyFile: string;
  /** Called once per HTTP request to Google (for api_usage). */
  onCall?: () => void;
  fetchFn?: typeof fetch;
}

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const API = "https://sheets.googleapis.com/v4/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const b64url = (v: Buffer | string) => Buffer.from(v).toString("base64url");

/** Sheets turns text starting with = + - @ into a formula. Merchant names are not ours, so defuse them. */
const safeText = (v: string | number) => (typeof v === "string" && /^[=+\-@]/.test(v) ? `'${v}` : v);

export class GoogleSheets implements SheetsClient {
  private key?: { client_email: string; private_key: string };
  private token?: { value: string; expiresAt: number };
  private formatTried = false;
  private fetchFn: typeof fetch;

  constructor(private opts: GoogleSheetsOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private loadKey() {
    if (this.key) return this.key;
    try {
      const j = JSON.parse(fs.readFileSync(this.opts.keyFile, "utf8"));
      if (typeof j.client_email !== "string" || typeof j.private_key !== "string") throw new Error();
      this.key = { client_email: j.client_email, private_key: j.private_key };
      return this.key;
    } catch {
      // Say what is wrong, never what is in the file.
      throw new SheetsError("cannot read GOOGLE_SERVICE_ACCOUNT_FILE (missing, or not a service account key)");
    }
  }

  /** One HTTP request to Google. Counted in api_usage, never throws on a bad status. */
  private async send(url: string, init: RequestInit) {
    this.opts.onCall?.();
    let res: Response;
    try {
      res = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new SheetsError(`network error talking to Google (${(err as Error).name})`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json().catch(() => ({}));
    return { res, json };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const key = this.loadKey();
    const iat = Math.floor(Date.now() / 1000);
    const claims = { iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 };
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
    let signature: string;
    try {
      signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
    } catch {
      throw new SheetsError("cannot sign with the service account key (is the private_key valid?)");
    }
    const { res, json } = await this.send(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
    });
    if (!res.ok || typeof json.access_token !== "string") {
      throw new SheetsError(`Google token request failed: HTTP ${res.status} ${String(json.error_description ?? json.error ?? "").slice(0, 150)}`);
    }
    this.token = { value: json.access_token, expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async sheetsCall(path: string, init: RequestInit = {}) {
    const token = await this.accessToken();
    const base = `${API}/${encodeURIComponent(this.opts.sheetId)}`;
    const { res, json } = await this.send(path.startsWith(":") ? `${base}${path}` : `${base}/${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      if (res.status === 401) this.token = undefined; // get a fresh token next time
      const msg = String(json?.error?.message ?? "").slice(0, 200);
      throw new SheetsError(`Google Sheets HTTP ${res.status}: ${msg}`, res.status !== 400);
    }
    return json;
  }

  private range(columns: string): string {
    return encodeURIComponent(`'${this.opts.tab.replace(/'/g, "''")}'!${columns}`);
  }

  async findRow(marker: string): Promise<number | null> {
    const json = await this.sheetsCall(`values/${this.range("F:F")}`);
    const rows: unknown[][] = Array.isArray(json.values) ? json.values : [];
    const index = rows.findIndex((r) => r[0] === marker);
    return index === -1 ? null : index + 1;
  }

  /**
   * Make column A show date AND time (yyyy-mm-dd hh:mm:ss). A column formatted as a plain date would
   * hide the time even though we write it. Done once per server run; it is cosmetic, so a failure
   * is logged and never blocks writing an expense.
   */
  private async ensureDateTimeColumn(): Promise<void> {
    if (this.formatTried) return;
    this.formatTried = true;
    try {
      const meta = await this.sheetsCall(`?fields=sheets.properties(sheetId,title)`);
      const tab = (meta.sheets as { properties?: { sheetId?: number; title?: string } }[] | undefined)?.find(
        (t) => t.properties?.title === this.opts.tab,
      );
      if (tab?.properties?.sheetId === undefined) return;
      await this.sheetsCall(":batchUpdate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              repeatCell: {
                range: { sheetId: tab.properties.sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
                cell: { userEnteredFormat: { numberFormat: { type: "DATE_TIME", pattern: "yyyy-mm-dd hh:mm:ss" } } },
                fields: "userEnteredFormat.numberFormat",
              },
            },
          ],
        }),
      });
    } catch (err) {
      console.warn(`[expenses] could not set the Date column to date+time: ${(err as Error).message}`);
    }
  }

  async appendRow(values: (string | number)[]): Promise<number | null> {
    await this.ensureDateTimeColumn();
    const json = await this.sheetsCall(
      `values/${this.range("A:G")}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: [values.map(safeText)] }),
      },
    );
    const m = /![A-Z]+(\d+)/.exec(String(json?.updates?.updatedRange ?? ""));
    return m ? Number(m[1]) : null;
  }

  async setMerchant(row: number, merchant: string): Promise<void> {
    await this.sheetsCall(`values/${this.range(`B${row}`)}?valueInputOption=USER_ENTERED`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: [[safeText(merchant)]] }),
    });
  }
}
