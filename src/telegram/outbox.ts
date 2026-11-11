import type Database from "better-sqlite3";
import { TelegramError, type Button } from "./api";
import { BACKOFF_MINUTES, MAX_MESSAGE_CHARS, OUTBOX_BATCH, OUTBOX_MAX_ATTEMPTS } from "./settings";
import { setState } from "./state";
import { nextNotifyTime } from "./time";

// Reliable sending. notify() saves the message to the outbox FIRST and then tries to send it. A
// failed send stays in the outbox and is retried (with backoff) by the telegram-outbox job, so a
// message is never lost because Telegram or the network was down for a moment.
// (If the process dies between Telegram accepting a message and us recording that, the message is
// sent again on restart: better twice than never.)

export interface NotifyOptions {
  buttons?: Button[][];
  /** Alerts: skip this message if one with the same key was queued within `cooldownMs`. */
  dedupeKey?: string;
  cooldownMs?: number;
  /** What the message is about, so the Telegram message id can be attached afterwards. */
  kind?: string;
  ref?: string;
  replyTo?: number;
  /** Not urgent: if it is night in Sydney (before 9am or after 11pm), hold it until 9am. */
  canWait?: boolean;
}

/** Sends one message to the owner and returns Telegram's message id. */
export type Sender = (text: string, options: { buttons?: Button[][]; replyTo?: number }) => Promise<number>;

export interface Outbox {
  /** Queue a message. Returns its outbox id, or null if an alert cooldown suppressed it. */
  notify(text: string, options?: NotifyOptions): number | null;
  /** Send everything that is due. Called right after notify() and by the minute job. */
  flush(): Promise<{ sent: number; failed: number }>;
}

interface Row {
  id: number;
  text: string;
  options: string | null;
  attempts: number;
  kind: string | null;
  ref: string | null;
}

export function createOutbox(deps: {
  db: Database.Database;
  /** null when Telegram is not configured: messages simply wait in the outbox. */
  send: Sender | null;
  onSent?: (row: { kind: string | null; ref: string | null }, messageId: number) => void;
  now?: () => Date;
  log?: (message: string) => void;
}): Outbox {
  const { db, send } = deps;
  const clock = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  let flushing = false;

  async function flush(): Promise<{ sent: number; failed: number }> {
    const result = { sent: 0, failed: 0 };
    if (!send || flushing) return result;
    flushing = true;
    try {
      for (;;) {
        const rows = db
          .prepare(
            `SELECT id, text, options, attempts, kind, ref, next_attempt_at FROM outbox
              WHERE status = 'pending' AND (send_after IS NULL OR send_after <= ?) ORDER BY id LIMIT ?`,
          )
          .all(clock().toISOString(), OUTBOX_BATCH) as (Row & { next_attempt_at: string })[];
        if (rows.length === 0) return result;

        let progressed = false;
        for (const row of rows) {
          // Messages go out in order: if the oldest one is still waiting out its backoff, so do the rest.
          if (row.next_attempt_at > clock().toISOString()) return result;
          progressed = true;
          const options = row.options ? (JSON.parse(row.options) as { buttons?: Button[][]; replyTo?: number }) : {};
          try {
            const messageId = await send(row.text, options);
            const now = clock();
            db.prepare(
              `UPDATE outbox SET status = 'sent', sent_at = ?, telegram_message_id = ?, error = NULL WHERE id = ?`,
            ).run(now.toISOString(), messageId, row.id);
            setState(db, "last_sent_at", now.toISOString(), now);
            setState(db, "last_send_error", null, now);
            result.sent++;
            try {
              deps.onSent?.(row, messageId);
            } catch (err) {
              log(`outbox #${row.id}: after-send step failed: ${(err as Error).message}`);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const attempts = row.attempts + 1;
            const waitMinutes = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
            const waitMs = Math.max(waitMinutes * 60_000, err instanceof TelegramError && err.retryAfter ? err.retryAfter * 1000 : 0);
            const now = clock();
            // HTTP 400 means this message itself is refused (it will never work): give up on it at
            // once, so it cannot hold up the messages behind it.
            const refused = err instanceof TelegramError && err.status === 400;
            db.prepare(
              `UPDATE outbox SET attempts = ?, error = ?, status = ?, next_attempt_at = ? WHERE id = ?`,
            ).run(
              attempts,
              message.slice(0, 300),
              refused || attempts >= OUTBOX_MAX_ATTEMPTS ? "failed" : "pending",
              new Date(now.getTime() + waitMs).toISOString(),
              row.id,
            );
            setState(db, "last_send_error", message.slice(0, 300), now);
            result.failed++;
            log(`outbox #${row.id}: send failed (attempt ${attempts}): ${message}`);
            // Anything but a refused message (network, bad token, rate limit, Telegram down) affects
            // all of them: stop here and retry later.
            if (!refused) return result;
          }
        }
        if (!progressed) return result;
      }
    } finally {
      flushing = false;
    }
  }

  function notify(text: string, options: NotifyOptions = {}): number | null {
    const now = clock();
    const id = db.transaction((): number | null => {
      if (options.dedupeKey) {
        const last = db.prepare(`SELECT last_sent_at FROM alert_state WHERE key = ?`).get(options.dedupeKey) as
          | { last_sent_at: string }
          | undefined;
        if (last && now.getTime() - Date.parse(last.last_sent_at) < (options.cooldownMs ?? 0)) {
          db.prepare(`UPDATE alert_state SET suppressed = suppressed + 1 WHERE key = ?`).run(options.dedupeKey);
          return null;
        }
        db.prepare(
          `INSERT INTO alert_state (key, last_sent_at) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET last_sent_at = excluded.last_sent_at`,
        ).run(options.dedupeKey, now.toISOString());
      }
      return Number(
        db
          .prepare(
            `INSERT INTO outbox (text, options, created_at, next_attempt_at, send_after, kind, ref) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            text.slice(0, MAX_MESSAGE_CHARS),
            options.buttons || options.replyTo ? JSON.stringify({ buttons: options.buttons, replyTo: options.replyTo }) : null,
            now.toISOString(),
            now.toISOString(),
            options.canWait ? nextNotifyTime(now).toISOString() : now.toISOString(),
            options.kind ?? null,
            options.ref ?? null,
          ).lastInsertRowid,
      );
    })();
    // Try to send straight away, after the current work (and any enclosing transaction) is done.
    if (id !== null) queueMicrotask(() => void flush().catch(() => {}));
    return id;
  }

  return { notify, flush };
}
