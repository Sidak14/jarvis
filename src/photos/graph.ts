import fs from "node:fs";
import { MS_GRAPH_BASE, SMALL_UPLOAD_MAX_BYTES, UPLOAD_CHUNK_BYTES } from "./settings";

// Microsoft Graph, for ONE job: put files into folders under "Uni Events" on the personal OneDrive.
//
// Safety by construction: every request goes through request(), which refuses
//  - any method except GET, POST and PUT (so nothing can ever be deleted or changed),
//  - any path except the drive's quota and items under an id this client has been told is inside Uni Events
//    (the Uni Events folder itself, and folders created or found below it).
// There is no list/search/delete function at all, and the file names used in paths are escaped.

export interface Quota {
  remaining: number;
  total: number;
  used: number;
}
export interface Folder {
  id: string;
  name: string;
}
export interface GraphClient {
  quota(): Promise<Quota>;
  /** A folder called `name` directly inside `parentId` (which must be Uni Events or a folder below it). Made only if missing. */
  ensureFolder(parentId: string, name: string): Promise<Folder>;
  /** Upload a local file as `fileName` inside `parentId`. Returns the OneDrive item id. An identical file already there counts as success. */
  uploadFile(parentId: string, fileName: string, filePath: string): Promise<string>;
}

export class GraphError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Fetch = typeof fetch;
const enc = (name: string) => encodeURIComponent(name);

export function createGraphClient(opts: { getToken: () => Promise<string>; rootId: string; fetchFn?: Fetch; baseUrl?: string; sleep?: (ms: number) => Promise<void> }): GraphClient {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.baseUrl ?? MS_GRAPH_BASE;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const inside = new Set<string>([opts.rootId]);

  async function request(method: "GET" | "POST" | "PUT", pathAndQuery: string, init: { json?: unknown; body?: Buffer; headers?: Record<string, string> } = {}): Promise<{ status: number; json: Record<string, any> }> {
    if (method !== "GET" && method !== "POST" && method !== "PUT") throw new Error("refused: only GET, POST and PUT are allowed");
    const m = /^\/me\/drive\/items\/([^/:?]+)/.exec(pathAndQuery);
    const isQuota = /^\/me\/drive\?\$select=quota$/.test(pathAndQuery);
    if (!isQuota && (!m || !inside.has(m[1]))) throw new Error("refused: that path is outside the Uni Events folder");

    for (let attempt = 0; ; attempt++) {
      const res = await fetchFn(`${base}${pathAndQuery}`, {
        method,
        headers: { Authorization: `Bearer ${await opts.getToken()}`, ...(init.json ? { "Content-Type": "application/json" } : {}), ...init.headers },
        body: (init.json ? JSON.stringify(init.json) : init.body) as BodyInit | undefined,
      });
      if ((res.status === 429 || res.status === 503) && attempt < 2) {
        await sleep(Math.min(30, Number(res.headers.get("retry-after")) || 2 ** attempt * 2) * 1000);
        continue;
      }
      const json = (await res.json().catch(() => ({}))) as Record<string, any>;
      return { status: res.status, json };
    }
  }
  // Graph error bodies are short codes ("nameAlreadyExists"); only that code is kept.
  const fail = (what: string, r: { status: number; json: Record<string, any> }) => new GraphError(r.status, `${what} failed (${r.status} ${String(r.json?.error?.code ?? "").slice(0, 60)})`);

  async function folderByName(parentId: string, name: string): Promise<Folder | null> {
    const r = await request("GET", `/me/drive/items/${parentId}:/${enc(name)}`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw fail("Looking up a folder", r);
    if (!r.json.folder) throw new GraphError(409, "A file (not a folder) already has that name");
    return { id: String(r.json.id), name: String(r.json.name) };
  }

  /** One request, or an upload session for big files. */
  async function upload(parentId: string, fileName: string, filePath: string): Promise<string> {
    const size = fs.statSync(filePath).size;
    const target = `/me/drive/items/${parentId}:/${enc(fileName)}:`;
    const existing = async () => {
      const r = await request("GET", target.slice(0, -1)); // same item, without the trailing colon
      if (r.status === 200 && Number(r.json.size) === size) return String(r.json.id);
      throw new GraphError(409, "A different file already has this name in the folder");
    };

    if (size <= SMALL_UPLOAD_MAX_BYTES) {
      const r = await request("PUT", `${target}/content?@microsoft.graph.conflictBehavior=fail`, { body: fs.readFileSync(filePath), headers: { "Content-Type": "application/octet-stream" } });
      if (r.status === 200 || r.status === 201) return String(r.json.id);
      if (r.status === 409) return existing();
      throw fail("Upload", r);
    }

    const session = await request("POST", `${target}/createUploadSession`, { json: { item: { "@microsoft.graph.conflictBehavior": "fail" } } });
    if (session.status === 409) return existing();
    if (session.status !== 200 || typeof session.json.uploadUrl !== "string") throw fail("Starting the upload", session);
    const uploadUrl = new URL(session.json.uploadUrl);
    if (uploadUrl.protocol !== "https:" && !(base.startsWith("http://") && uploadUrl.origin === new URL(base).origin)) throw new Error("refused: the upload address is not https");

    const fd = fs.openSync(filePath, "r");
    try {
      for (let start = 0; start < size; start += UPLOAD_CHUNK_BYTES) {
        const len = Math.min(UPLOAD_CHUNK_BYTES, size - start);
        const chunk = Buffer.alloc(len);
        fs.readSync(fd, chunk, 0, len, start);
        // The upload address is already authorised by Microsoft: it must NOT get our bearer token.
        let res: Response | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          res = await fetchFn(uploadUrl, { method: "PUT", headers: { "Content-Length": String(len), "Content-Range": `bytes ${start}-${start + len - 1}/${size}` }, body: chunk as unknown as BodyInit });
          if (res.status < 500 && res.status !== 429) break;
          await sleep(2 ** attempt * 2000);
        }
        const json = (await res!.json().catch(() => ({}))) as Record<string, any>;
        if (res!.status === 200 || res!.status === 201) return String(json.id);
        if (res!.status !== 202) throw new GraphError(res!.status, `Upload chunk failed (${res!.status})`);
      }
    } finally {
      fs.closeSync(fd);
    }
    throw new GraphError(500, "The upload finished without OneDrive confirming the file");
  }

  return {
    async quota() {
      const r = await request("GET", `/me/drive?$select=quota`);
      if (r.status !== 200 || typeof r.json.quota?.remaining !== "number") throw fail("Checking OneDrive space", r);
      return { remaining: r.json.quota.remaining, total: r.json.quota.total, used: r.json.quota.used };
    },
    async ensureFolder(parentId, name) {
      const found = await folderByName(parentId, name);
      if (found) {
        inside.add(found.id);
        return found;
      }
      const r = await request("POST", `/me/drive/items/${parentId}/children`, { json: { name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" } });
      if (r.status === 201 || r.status === 200) {
        inside.add(String(r.json.id));
        return { id: String(r.json.id), name: String(r.json.name) };
      }
      if (r.status === 409) {
        const again = await folderByName(parentId, name); // someone (or an earlier run) made it a moment ago
        if (again) {
          inside.add(again.id);
          return again;
        }
      }
      throw fail("Creating a folder", r);
    },
    uploadFile: upload,
  };
}
