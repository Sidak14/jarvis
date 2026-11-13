import type Database from "better-sqlite3";
import { AiCapError, LlmError } from "../ai/llm";
import { LlmJsonError } from "../ai/json";
import { dayKey, startOfDay, zoned } from "../telegram/time";
import { applyResults, type BatchMessage } from "./apply";
import type { DetectInput, Detector, PromptMessage, PromptPlan } from "./detect";
import { looksLikePlan } from "./prefilter";
import {
  BATCH_MAX_MESSAGES,
  FORCE_AFTER_MS,
  MAX_DETECT_ATTEMPTS,
  OPEN_PLAN_DM_DAYS,
  PLANS_IN_PROMPT,
  PLANS_RECENT_DAYS,
  PLANS_UPCOMING_DAYS,
  QUIET_MS,
} from "./settings";
import { allPlans, setState, stanceTimeline, type Plan } from "./store";

// Decides WHEN a chat's unprocessed messages go to the model, builds the input, and hands the
// answer to apply.ts. One model call per chat batch.

interface PendingRow {
  id: string;
  kind: "text" | "reaction";
  sender_id: string | null;
  sender_name: string | null;
  is_me: number;
  ts: string;
  text: string | null;
  reaction_key: string | null;
  target_id: string | null;
  seen_at: string;
  attempts: number;
}

export interface DetectionRun {
  batches: number;
  skippedByPrefilter: number;
  created: number;
  updated: number;
  linked: number;
  possibleLinks: number;
  rejected: number;
  failed: number;
  stoppedBecause: string | null;
}

const dayOffset = (now: Date, days: number) => {
  const z = zoned(now);
  return dayKey(new Date(startOfDay(z.year, z.month, z.day + days).getTime() + 12 * 3_600_000));
};

/** Open plans from ALL chats that the model gets to see: the next 30 days and the last 14, at most 30. */
export function plansForPrompt(db: Database.Database, now: Date): Plan[] {
  const from = dayOffset(now, -PLANS_RECENT_DAYS);
  const to = dayOffset(now, PLANS_UPCOMING_DAYS);
  const today = dayOffset(now, 0);
  return allPlans(db)
    .filter((p) => p.plan_status !== "cancelled" && (p.date === null || (p.date >= from && p.date <= to)))
    .sort((a, b) => Math.abs(Date.parse(a.date ?? today) - Date.parse(today)) - Math.abs(Date.parse(b.date ?? today) - Date.parse(today)))
    .slice(0, PLANS_IN_PROMPT);
}

const planChatIds = (p: Plan) => [p.source_chat_id, ...p.linked_chats.map((c) => c.id)];

function membership(db: Database.Database): (senderId: string, plan: Plan) => boolean {
  const q = db.prepare(`SELECT 1 FROM plan_members WHERE chat_id = ? AND user_id = ?`);
  return (senderId, plan) => planChatIds(plan).some((c) => !!q.get(c, senderId));
}

/** DMs only: does this batch look like it could be about a plan? (Cheap code, no model.) */
export function dmPassesPrefilter(db: Database.Database, rows: PendingRow[], now: Date): boolean {
  if (rows.some((r) => r.kind === "text" && r.text && looksLikePlan(r.text))) return true;
  // Or the sender is in a chat that has an open plan in the next 14 days.
  const today = dayOffset(now, 0);
  const soon = dayOffset(now, OPEN_PLAN_DM_DAYS);
  const inChat = membership(db);
  const open = allPlans(db).filter((p) => p.plan_status !== "cancelled" && p.date !== null && p.date >= today && p.date <= soon);
  return rows.some((r) => !r.is_me && r.sender_id && open.some((p) => inChat(r.sender_id!, p)));
}

export async function runDetection(deps: {
  db: Database.Database;
  /** null when AI is not configured: batches stay pending. */
  detector: Detector | null;
  /** Later: a cheap "is this about a plan?" classifier (Jev) can say no before Haiku is called. */
  gate?: (input: DetectInput) => Promise<boolean>;
  now?: Date;
  log?: (m: string) => void;
}): Promise<DetectionRun> {
  const { db } = deps;
  const now = deps.now ?? new Date();
  const log = deps.log ?? (() => {});
  const run: DetectionRun = { batches: 0, skippedByPrefilter: 0, created: 0, updated: 0, linked: 0, possibleLinks: 0, rejected: 0, failed: 0, stoppedBecause: null };
  if (!deps.detector) return run;

  const chats = db
    .prepare(
      `SELECT m.chat_id, MAX(m.ts) AS newest, MIN(m.seen_at) AS first_seen, c.name, c.type FROM plan_messages m
         LEFT JOIN plan_chat_state c ON c.chat_id = m.chat_id WHERE m.status = 'pending' GROUP BY m.chat_id`,
    )
    .all() as { chat_id: string; newest: string; first_seen: string; name: string | null; type: string | null }[];

  const markDone = (chatId: string, ids: string[], status: "processed" | "skipped") =>
    db.prepare(`UPDATE plan_messages SET status = ?, text = NULL, sender_name = NULL, processed_at = ? WHERE chat_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
      .run(status, now.toISOString(), chatId, ...ids);

  for (const chat of chats) {
    // Quiet for 3 minutes, or busy for 30: whichever comes first.
    const quiet = now.getTime() - Date.parse(chat.newest) >= QUIET_MS;
    const forced = now.getTime() - Date.parse(chat.first_seen) >= FORCE_AFTER_MS;
    if (!quiet && !forced) continue;

    const rows = db
      .prepare(`SELECT id, kind, sender_id, sender_name, is_me, ts, text, reaction_key, target_id, seen_at, attempts FROM plan_messages WHERE chat_id = ? AND status = 'pending' ORDER BY ts, id LIMIT ?`)
      .all(chat.chat_id, BATCH_MAX_MESSAGES) as PendingRow[];
    if (rows.length === 0) continue;
    const chatName = chat.name ?? chat.chat_id;
    const chatType = chat.type === "single" ? "single" : "group";

    if (chatType === "single" && !dmPassesPrefilter(db, rows, now)) {
      markDone(chat.chat_id, rows.map((r) => r.id), "skipped");
      run.skippedByPrefilter++;
      continue;
    }

    const plans = plansForPrompt(db, now);
    const inChat = membership(db);
    const input: DetectInput = {
      now,
      chatName,
      chatType,
      plans: plans.map(
        (p): PromptPlan => ({
          code: `P-${String(p.id).padStart(4, "0")}`,
          title: p.title,
          date: p.date,
          startTime: p.start_time,
          location: p.location,
          chatName: p.source_chat_name,
          linkedChatNames: p.linked_chats.map((c) => c.name),
          status: p.plan_status,
          participants: p.participants,
          stanceHistory: stanceTimeline(db, p.id).map((s) => ({ stance: s.stance, ts: s.ts })),
        }),
      ),
      messages: rows.map(
        (r): PromptMessage => ({
          id: r.id,
          ts: r.ts,
          sender: r.is_me ? "me" : r.sender_name || "someone",
          isMe: !!r.is_me,
          kind: r.kind,
          text: r.text ?? "",
          reactionKey: r.reaction_key,
          targetId: r.target_id,
          inPlanChatsOf: r.sender_id && !r.is_me ? plans.filter((p) => inChat(r.sender_id!, p)).map((p) => `P-${String(p.id).padStart(4, "0")}`) : [],
        }),
      ),
    };
    if (deps.gate && !(await deps.gate(input))) {
      markDone(chat.chat_id, rows.map((r) => r.id), "skipped");
      continue;
    }

    try {
      const { results, rejected } = await deps.detector.detect(input);
      const ctxMessages = new Map<string, BatchMessage>(
        rows.map((r) => [r.id, { id: r.id, senderId: r.sender_id ?? "", isMe: !!r.is_me, ts: r.ts, kind: r.kind }]),
      );
      // Apply the answer and mark the messages done in ONE transaction, so a crash in between
      // can never leave them to be applied a second time.
      const report = db.transaction(() => {
        const rep = applyResults(db, { chatId: chat.chat_id, chatName, messages: ctxMessages, now }, results);
        markDone(chat.chat_id, rows.map((r) => r.id), "processed");
        db.prepare(`UPDATE plan_chat_state SET last_batch_at = ? WHERE chat_id = ?`).run(now.toISOString(), chat.chat_id);
        return rep;
      })();
      run.batches++;
      run.created += report.created.length;
      run.updated += report.updated.length;
      run.linked += report.linked.length;
      run.possibleLinks += report.possibleLinks.length;
      run.rejected += report.rejected.length + rejected;
      setState(db, "last_batch_at", now.toISOString(), now);
      setState(db, "last_batch_summary", `${chatName}: ${rows.length} messages, ${report.created.length} new, ${report.updated.length} updated${report.rejected.length ? `, ${report.rejected.length} rejected` : ""}`, now);
      log(`${chatName}: ${rows.length} messages -> ${report.created.length} new, ${report.updated.length} updated, ${report.linked.length} linked`);
      for (const why of report.rejected) log(`  rejected: ${why}`);
    } catch (err) {
      if (err instanceof AiCapError) {
        run.stoppedBecause = `AI paused: ${err.message}`;
        log(run.stoppedBecause);
        break; // every chat would hit the same cap
      }
      if (err instanceof LlmError || err instanceof LlmJsonError) {
        run.failed++;
        db.prepare(`UPDATE plan_messages SET attempts = attempts + 1 WHERE chat_id = ? AND id IN (${rows.map(() => "?").join(",")})`).run(chat.chat_id, ...rows.map((r) => r.id));
        const giveUp = rows.filter((r) => r.attempts + 1 >= MAX_DETECT_ATTEMPTS).map((r) => r.id);
        if (giveUp.length) markDone(chat.chat_id, giveUp, "skipped");
        log(`${chatName}: model call failed (${(err as Error).message})`);
        continue;
      }
      throw err;
    }
  }
  return run;
}
