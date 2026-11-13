import type Database from "better-sqlite3";
import { loadAllowlist } from "./allowlist";
import type { BeeperChat, BeeperReader } from "./beeper";
import {
  BACKFILL_DAYS,
  KEEP_MESSAGE_IDS_DAYS,
  MAX_PAGES_PER_CHAT,
  MAX_TEXT_CHARS,
  MEMBERS_REFRESH_MS,
  RESCAN_WINDOW_MS,
} from "./settings";
import { getState, setState } from "./store";

// Polling: read new messages (and new reactions) from Beeper into plan_messages as 'pending'.
// No model is involved here, so it costs nothing. A message is stored once (chat id + message id is
// the primary key), so reading the same messages again is harmless.

export interface IngestResult {
  chatsPolled: number;
  eligible: number;
  newMessages: number;
  newReactions: number;
  allowlistError: string | null;
}

/** Why a chat is read: 'allowlist', 'dm-of-member' (a DM with someone in an allowlisted group) or 'all'. */
export type WhyRead = "allowlist" | "dm-of-member" | "all";

const clip = (s: string, n: number) => s.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n);

/** The moment before which messages are never processed. Set once, on the first start. */
export function ensureHorizon(db: Database.Database, backfill: boolean, now: Date): string {
  const existing = getState(db, "horizon");
  if (existing) return existing;
  const horizon = new Date(backfill ? now.getTime() - BACKFILL_DAYS * 86_400_000 : now.getTime()).toISOString();
  setState(db, "started_at", now.toISOString(), now);
  setState(db, "horizon", horizon, now);
  return horizon;
}

function saveMembers(db: Database.Database, chat: BeeperChat): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM plan_members WHERE chat_id = ?`).run(chat.id);
    const insert = db.prepare(`INSERT OR IGNORE INTO plan_members (chat_id, user_id, is_self) VALUES (?, ?, ?)`);
    for (const m of chat.members) insert.run(chat.id, m.id, m.isSelf ? 1 : 0);
  })();
}

export async function pollChats(deps: {
  db: Database.Database;
  reader: BeeperReader;
  dataDir: string;
  allChats: boolean;
  backfill: boolean;
  now?: Date;
  log?: (m: string) => void;
}): Promise<IngestResult> {
  const { db, reader } = deps;
  const now = deps.now ?? new Date();
  const log = deps.log ?? (() => {});
  const horizon = ensureHorizon(db, deps.backfill, now);
  const result: IngestResult = { chatsPolled: 0, eligible: 0, newMessages: 0, newReactions: 0, allowlistError: null };

  const chats = await reader.listChats();
  const allow = loadAllowlist(deps.dataDir);
  result.allowlistError = allow.error;
  const allowedIds = new Set(allow.chats.map((c) => c.id));

  // 1. Member lists of the groups we read (refreshed hourly), so DMs with members can be found.
  const memberRefreshed = db.prepare(`SELECT 1 FROM plans_state WHERE key = ? AND updated_at > ?`);
  const readGroups = chats.filter((c) => c.type === "group" && (deps.allChats || allowedIds.has(c.id)));
  for (const g of readGroups) {
    const fresh = memberRefreshed.get(`members:${g.id}`, new Date(now.getTime() - MEMBERS_REFRESH_MS).toISOString());
    if (fresh) continue;
    try {
      saveMembers(db, await reader.getChat(g.id));
      setState(db, `members:${g.id}`, "ok", now);
    } catch (err) {
      log(`could not read the members of ${g.name}: ${(err as Error).message}`);
    }
  }
  const groupMemberIds = new Set(
    (
      db
        .prepare(`SELECT DISTINCT user_id FROM plan_members WHERE is_self = 0 AND chat_id IN (${readGroups.map(() => "?").join(",") || "NULL"})`)
        .all(...readGroups.map((g) => g.id)) as { user_id: string }[]
    ).map((r) => r.user_id),
  );

  // 2. Which chats are read, and why.
  const eligible: { chat: BeeperChat; why: WhyRead }[] = [];
  for (const chat of chats) {
    if (deps.allChats) eligible.push({ chat, why: "all" });
    else if (allowedIds.has(chat.id)) eligible.push({ chat, why: "allowlist" });
    else if (chat.type === "single" && chat.members.some((m) => !m.isSelf && groupMemberIds.has(m.id))) {
      eligible.push({ chat, why: "dm-of-member" });
    }
  }
  result.eligible = eligible.length;

  // 3. Read each eligible chat that has had activity lately (or has never been read).
  const windowStart = new Date(now.getTime() - RESCAN_WINDOW_MS).toISOString();
  const knownChat = db.prepare(`SELECT last_polled_at FROM plan_chat_state WHERE chat_id = ?`);
  const upsertChat = db.prepare(
    `INSERT INTO plan_chat_state (chat_id, name, type, why, last_polled_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name, type = excluded.type, why = excluded.why, last_polled_at = excluded.last_polled_at`,
  );
  for (const { chat, why } of eligible) {
    const polledBefore = knownChat.get(chat.id) as { last_polled_at: string | null } | undefined;
    if (polledBefore && chat.lastActivity && chat.lastActivity < windowStart) continue;
    try {
      if (chat.type === "single") saveMembers(db, chat); // a DM's two people are always complete
      // First look at a chat with backfill on: go back to the horizon (7 days). Otherwise just the last 3 days.
      const firstLook = !polledBefore;
      const since = firstLook && deps.backfill ? horizon : windowStart;
      const messages = await reader.recentMessages(chat.id, since, firstLook && deps.backfill ? MAX_PAGES_PER_CHAT * 5 : MAX_PAGES_PER_CHAT);
      const counts = storeMessages(db, chat.id, messages, horizon, now);
      result.newMessages += counts.messages;
      result.newReactions += counts.reactions;
      upsertChat.run(chat.id, chat.name, chat.type, why, now.toISOString());
      result.chatsPolled++;
    } catch (err) {
      log(`could not read ${chat.name}: ${(err as Error).message}`);
    }
  }

  // 4. Forget message ids that are far too old to come back.
  db.prepare(`DELETE FROM plan_messages WHERE status != 'pending' AND seen_at < ?`).run(
    new Date(now.getTime() - KEEP_MESSAGE_IDS_DAYS * 86_400_000).toISOString(),
  );
  return result;
}

/** Save messages and reactions that are new. Exported for the tests. */
export function storeMessages(
  db: Database.Database,
  chatId: string,
  messages: import("./beeper").BeeperMessage[],
  horizon: string,
  now: Date,
): { messages: number; reactions: number } {
  const counts = { messages: 0, reactions: 0 };
  const find = db.prepare(`SELECT 1 FROM plan_messages WHERE chat_id = ? AND id = ?`);
  const insertMessage = db.prepare(
    `INSERT INTO plan_messages (chat_id, id, kind, sender_id, sender_name, is_me, ts, text, status, seen_at)
     VALUES (?, ?, 'text', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const seenReaction = db.prepare(
    `INSERT OR IGNORE INTO plan_reactions_seen (chat_id, message_id, participant_id, reaction_key) VALUES (?, ?, ?, ?)`,
  );
  const insertReaction = db.prepare(
    `INSERT OR IGNORE INTO plan_messages (chat_id, id, kind, sender_id, sender_name, is_me, ts, text, reaction_key, target_id, status, seen_at)
     VALUES (?, ?, 'reaction', ?, '', ?, ?, ?, ?, ?, 'pending', ?)`,
  );

  db.transaction(() => {
    for (const m of [...messages].sort((a, b) => a.ts.localeCompare(b.ts))) {
      const isNew = !find.get(chatId, m.id);
      const old = m.ts < horizon;
      if (isNew) {
        insertMessage.run(chatId, m.id, m.senderId, clip(m.senderName, 60), m.isMe ? 1 : 0, m.ts, old ? null : clip(m.text, MAX_TEXT_CHARS), old ? "baseline" : "pending", now.toISOString());
        if (!old) counts.messages++;
      }
      for (const r of m.reactions) {
        if (seenReaction.run(chatId, m.id, r.participantId, r.key).changes === 0) continue;
        if (isNew && old) continue; // already there when we first looked: not news
        const id = `r:${m.id}:${r.participantId}:${r.key}`;
        insertReaction.run(chatId, id, r.participantId, r.isMe ? 1 : 0, now.toISOString(), clip(m.text, 200), clip(r.key, 40), m.id, now.toISOString());
        counts.reactions++;
      }
    }
  })();
  return counts;
}
