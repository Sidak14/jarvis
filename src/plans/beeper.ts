import BeeperDesktop from "@beeper/desktop-api";
import { ALLOWED_BRIDGES, CHATS_PAGE_LIMIT, CHATS_SCAN_LIMIT, PHOTO_MAX_BYTES, PHOTO_MIME_TYPES } from "./settings";

// READ-ONLY, INSTAGRAM-ONLY access to Beeper Server's local API (http://127.0.0.1:23373).
// The SDK client stays private to this file, and the reader below has no way to send, edit or
// delete anything: there is nothing to call. (A test checks that no send/edit/delete call to the
// SDK exists anywhere in src/plans.)
//
// Endpoints used, checked against the SDK types and developers.beeper.com/desktop-api:
//   GET /v1/accounts                         -> connection check + my own user ids
//   GET /v1/chats?limit=200                  -> chats, most recent activity first
//   GET /v1/chats/{id}?maxParticipantCount=-1 -> all participants (each has id and isSelf)
//   GET /v1/chats/{id}/messages?cursor&direction=before|after -> messages (reactions are embedded
//        in each message's `reactions` array)

export interface BeeperChat {
  id: string;
  /** Beeper account id, e.g. "instagramgo.105330570868195": the part before the dot is the network. */
  accountId: string;
  name: string;
  type: "single" | "group";
  lastActivity: string | null;
  members: { id: string; isSelf: boolean }[];
  /** false when the member list may be cut off (list calls return only 20 per chat) */
  membersComplete: boolean;
}
export interface BeeperMessage {
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  isMe: boolean;
  ts: string; // ISO
  text: string;
  /** A photo sent in this message (not a GIF or sticker). `text` is then only its caption, possibly empty. */
  photo?: { url: string; mime: string };
  /** Set by ingest: a photo that is not about a plan is remembered (so it is not read again) but never sent on. */
  skip?: boolean;
  reactions: { participantId: string; key: string; isMe: boolean }[];
}
export interface BeeperReader {
  /** Throws if Beeper Desktop cannot be reached or the token is wrong. */
  check(): Promise<{ accounts: number }>;
  listChats(): Promise<BeeperChat[]>;
  getChat(id: string): Promise<BeeperChat>;
  /** Text messages newer than `sinceIso`, newest page first, at most `maxPages` pages. */
  recentMessages(chatId: string, sinceIso: string, maxPages: number): Promise<BeeperMessage[]>;
  /** The bytes of a photo from a message of an allowed chat, or null if it is too big or not a plain photo. */
  fetchPhoto(chatId: string, photo: { url: string; mime: string }): Promise<{ mime: string; base64: string } | null>;
}

/** True only for chats on a network Jarvis is allowed to read (Instagram). Everything else is ignored. */
export const isAllowedNetwork = (accountId: string) => ALLOWED_BRIDGES.includes(accountId.split(".")[0]);

/** The first plain photo among a message's attachments (small enough, a normal image type, not a GIF or sticker). */
function photoOf(attachments: { type: string; srcURL?: string; id?: string; mimeType?: string; fileSize?: number; isGif?: boolean; isSticker?: boolean }[] | undefined) {
  for (const a of attachments ?? []) {
    const url = a.srcURL ?? a.id;
    if (a.type !== "img" || a.isGif || a.isSticker || !url || !a.mimeType || !PHOTO_MIME_TYPES.includes(a.mimeType)) continue;
    if (a.fileSize !== undefined && a.fileSize > PHOTO_MAX_BYTES) continue;
    return { url, mime: a.mimeType };
  }
  return undefined;
}

type SdkChat = Awaited<ReturnType<BeeperDesktop["chats"]["retrieve"]>>;

export function createBeeperReader(opts: { accessToken: string; baseURL: string }): BeeperReader {
  const client = new BeeperDesktop({ accessToken: opts.accessToken, baseURL: opts.baseURL, maxRetries: 1, timeout: 20_000 });
  let selfIds = new Set<string>();
  // Chats seen on an allowed network. A message read for any other chat id is refused.
  const readable = new Set<string>();
  // Photo urls seen on messages (with their chat): only those can be fetched.
  const photoUrls = new Set<string>();

  const toChat = (c: SdkChat): BeeperChat => ({
    id: c.id,
    accountId: c.accountID,
    name: c.title || c.id,
    type: c.type,
    lastActivity: c.lastActivity ?? null,
    members: c.participants.items.map((p) => ({ id: p.id, isSelf: Boolean(p.isSelf) })),
    membersComplete: !c.participants.hasMore,
  });

  return {
    async check() {
      const accounts = await client.accounts.list();
      selfIds = new Set(accounts.map((a) => a.user.id));
      return { accounts: accounts.length };
    },

    async listChats() {
      const chats: BeeperChat[] = [];
      let scanned = 0;
      for await (const c of client.chats.list({ limit: CHATS_PAGE_LIMIT })) {
        scanned++;
        if (isAllowedNetwork(c.accountID)) {
          readable.add(c.id);
          chats.push(toChat(c));
        }
        if (chats.length >= CHATS_PAGE_LIMIT || scanned >= CHATS_SCAN_LIMIT) break;
      }
      return chats;
    },

    async getChat(id) {
      const chat = await client.chats.retrieve(id, { maxParticipantCount: -1 });
      if (!isAllowedNetwork(chat.accountID)) throw new Error("that chat is not on an allowed network");
      readable.add(chat.id);
      return toChat(chat);
    },

    async fetchPhoto(chatId, photo) {
      if (!readable.has(chatId) || !photoUrls.has(`${chatId} ${photo.url}`)) throw new Error("that photo is not from an allowed chat");
      const res = await client.assets.serve({ url: photo.url });
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > PHOTO_MAX_BYTES) return null;
      return { mime: photo.mime, base64: bytes.toString("base64") };
    },

    async recentMessages(chatId, sinceIso, maxPages) {
      if (!readable.has(chatId)) throw new Error("that chat is not on an allowed network");
      const found: BeeperMessage[] = [];
      let cursor: string | null | undefined;
      for (let page = 0; page < maxPages; page++) {
        const res = await client.messages.list(chatId, cursor ? { cursor, direction: "before" } : undefined);
        for (const m of res.items) {
          // Text and photos only: other media, reaction events, notices and state events are ignored.
          if (m.isDeleted || m.isHidden) continue;
          const photo = m.type === "IMAGE" ? photoOf(m.attachments) : undefined;
          if (!photo && (m.type !== "TEXT" || !m.text?.trim())) continue;
          if (photo) photoUrls.add(`${chatId} ${photo.url}`);
          found.push({
            id: m.id,
            chatId,
            senderId: m.senderID,
            senderName: m.senderName ?? "",
            isMe: Boolean(m.isSender) || selfIds.has(m.senderID),
            ts: new Date(m.timestamp).toISOString(),
            text: m.text ?? "",
            photo,
            reactions: (m.reactions ?? []).map((r) => ({
              participantId: r.participantID,
              key: r.reactionKey,
              isMe: selfIds.has(r.participantID),
            })),
          });
        }
        // The docs do not say whether a page is newest-first, so look at the timestamps: stop
        // when the OLDEST message on the page is already older than we need.
        const times = res.items.map((m) => Date.parse(m.timestamp)).filter(Number.isFinite);
        const oldest = times.length ? Math.min(...times) : Infinity;
        if (!res.hasMore || !res.oldestCursor || oldest < Date.parse(sinceIso)) break;
        cursor = res.oldestCursor;
      }
      return found.filter((m) => m.ts > sinceIso);
    },
  };
}
