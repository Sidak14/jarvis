// Timestamps for expenses. The Sheet wants a date AND a time, so we never settle for a bare date
// when we know roughly when something happened.

/** True if the text has a time of day in it ("12:27", "T12:27:00Z"). */
export const hasTimeOfDay = (s: string) => /\d{1,2}:\d{2}/.test(s);

/** Calendar day (YYYY-MM-DD) of a moment, in this Mac's time zone. */
const localDay = (d: Date) => d.toLocaleDateString("sv-SE");

/**
 * Turn a timestamp we were given (from an email or a Wallet tap) into a full ISO datetime.
 * - It has a time: use it as is.
 * - It is only a date: the moment we received the message is the best guess for the time, as long
 *   as the date is the same day (give or take one day, for time zones). A receipt for a purchase
 *   from a different day keeps that date, at midday.
 * - Not a date at all: null (the caller falls back to `anchorIso`).
 * `anchorIso` is when the email arrived, or when the webhook was called.
 */
export function resolveTimestamp(value: string | null | undefined, anchorIso: string): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  if (hasTimeOfDay(value)) return new Date(parsed).toISOString();

  const valueDay = /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : localDay(new Date(parsed));
  const gapDays = Math.abs(Date.parse(`${valueDay}T00:00:00Z`) - Date.parse(`${localDay(new Date(anchorIso))}T00:00:00Z`)) / 86_400_000;
  if (gapDays <= 1) return new Date(anchorIso).toISOString();
  return new Date(`${valueDay}T12:00:00`).toISOString(); // local midday
}
