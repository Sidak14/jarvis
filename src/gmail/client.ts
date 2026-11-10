import type Database from "better-sqlite3";
import { recordApiCall } from "../spotify/usage";
import type { GmailAuth } from "./auth";
import { parseMessage, type EmailMessage } from "./message";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** The two things Jarvis needs from Gmail. Tests swap in a fake one. */
export interface GmailClient {
  /** Ids of messages matching a Gmail search, newest first. */
  listMessageIds(query: string, max: number): Promise<string[]>;
  getMessage(id: string): Promise<EmailMessage>;
}

export class GmailError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export function createGmailClient(
  auth: Pick<GmailAuth, "getAccessToken">,
  db: Database.Database,
  fetchFn: typeof fetch = fetch,
): GmailClient {
  /** One Gmail call: adds the token, counts it in api_usage, retries once on 401. */
  async function call(path: string): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await auth.getAccessToken(attempt === 1);
      recordApiCall(db, "gmail");
      let res: Response;
      try {
        res = await fetchFn(`${API}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        throw new GmailError(`network error talking to Gmail (${(err as Error).name})`);
      }
      if (res.status === 401 && attempt === 0) continue;
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!res.ok) {
        throw new GmailError(`Gmail HTTP ${res.status}: ${String(json.error?.message ?? "").slice(0, 150)}`, res.status);
      }
      return json;
    }
    throw new GmailError("Gmail rejected the access token (401)", 401);
  }

  return {
    async listMessageIds(query, max) {
      const ids: string[] = [];
      let pageToken = "";
      while (ids.length < max) {
        const params = new URLSearchParams({ q: query, maxResults: String(Math.min(100, max - ids.length)) });
        if (pageToken) params.set("pageToken", pageToken);
        const json = (await call(`/messages?${params}`)) as {
          messages?: { id: string }[];
          nextPageToken?: string;
        };
        for (const m of json.messages ?? []) ids.push(m.id);
        if (!json.nextPageToken) break;
        pageToken = json.nextPageToken;
      }
      return ids.slice(0, max);
    },

    async getMessage(id) {
      const json = await call(`/messages/${encodeURIComponent(id)}?format=full`);
      return parseMessage(json as Parameters<typeof parseMessage>[0]);
    },
  };
}
