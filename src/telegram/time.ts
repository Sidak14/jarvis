import { NOTIFY_END_MINUTE, NOTIFY_START_MINUTE, TIMEZONE } from "./settings";

// Everything about "when" is Sydney time, whatever time zone this Mac is set to.

const formatter = new Intl.DateTimeFormat("en-AU", {
  timeZone: TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});

export interface Zoned {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

export function zoned(date: Date): Zoned {
  const p = Object.fromEntries(formatter.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour % 24,
    minute: +p.minute,
    second: +p.second,
    weekday: p.weekday,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-10": the Sydney calendar day of a moment. */
export const dayKey = (d: Date) => {
  const z = zoned(d);
  return `${z.year}-${pad(z.month)}-${pad(z.day)}`;
};
/** "2026-11" */
export const monthKey = (d: Date) => dayKey(d).slice(0, 7);

/** How far Sydney is ahead of UTC at this moment, in ms (DST aware). */
function offsetMs(d: Date): number {
  const z = zoned(d);
  return Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second) - Math.floor(d.getTime() / 1000) * 1000;
}

/** The exact moment it is `minutes` after midnight on this Sydney calendar day (daylight saving aware). */
export function zonedTime(year: number, month: number, day: number, minutes: number): Date {
  const naive = Date.UTC(year, month - 1, day, 0, minutes);
  let t = naive - offsetMs(new Date(naive));
  t = naive - offsetMs(new Date(t)); // second pass settles the daylight-saving edge
  return new Date(t);
}

/** The moment Sydney's midnight starts on this calendar day. */
export function startOfDay(year: number, month: number, day: number): Date {
  return zonedTime(year, month, day, 0);
}

/** "Sat 14 Nov": the Sydney day of a moment. */
export function dayLabel(d: Date): string {
  const month = d.toLocaleString("en-AU", { month: "short", timeZone: TIMEZONE });
  const z = zoned(d);
  return `${z.weekday} ${z.day} ${month}`;
}

/** Start (inclusive) and end (exclusive) of a Sydney calendar month, "YYYY-MM". */
export function monthRange(key: string): { start: Date; end: Date } {
  const [y, m] = key.split("-").map(Number);
  const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
  return { start: startOfDay(y, m, 1), end: startOfDay(ny, nm, 1) };
}

export function previousMonthKey(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

export function monthName(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleString("en-AU", { month: "long", timeZone: "UTC" });
}

/** Messages that can wait are only sent between 09:00 and 23:00 Sydney time. */
export function inNotifyWindow(now: Date): boolean {
  const z = zoned(now);
  const minutes = z.hour * 60 + z.minute;
  return minutes >= NOTIFY_START_MINUTE && minutes <= NOTIFY_END_MINUTE;
}

/** Now if it is daytime in Sydney, otherwise the next 9:00am. */
export function nextNotifyTime(now: Date): Date {
  if (inNotifyWindow(now)) return now;
  const z = zoned(now);
  // After 11pm: tomorrow's 9am. Before 9am: today's.
  const day = z.hour * 60 + z.minute > NOTIFY_START_MINUTE ? z.day + 1 : z.day;
  return zonedTime(z.year, z.month, day, NOTIFY_START_MINUTE);
}

/** "2:14pm" */
export function formatClock(d: Date): string {
  const z = zoned(d);
  return `${z.hour % 12 || 12}:${pad(z.minute)}${z.hour < 12 ? "am" : "pm"}`;
}

/** "2:14pm" for today, "Sun 9 Nov, 2:14pm" for another day. */
export function formatWhen(d: Date, now: Date): string {
  if (dayKey(d) === dayKey(now)) return formatClock(d);
  const z = zoned(d);
  const month = d.toLocaleString("en-AU", { month: "short", timeZone: TIMEZONE });
  return `${z.weekday} ${z.day} ${month}, ${formatClock(d)}`;
}
