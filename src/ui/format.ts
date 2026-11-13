// The one place that turns numbers, moments and cron schedules into words. Templates never format anything
// themselves. Everything is Australia/Sydney, and every function takes `now` so it can be tested.

export const TZ = "Australia/Sydney";

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const partsFormat = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23", weekday: "short" });

interface Z {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}
function zoned(d: Date): Z {
  const p = Object.fromEntries(partsFormat.formatToParts(d).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second, weekday: p.weekday };
}
const dayNumber = (z: Z) => Math.floor(Date.UTC(z.year, z.month - 1, z.day) / 86_400_000);
const pad = (n: number) => String(n).padStart(2, "0");

/** "9:05 am" */
export function clock(d: Date): string {
  const z = zoned(d);
  return `${z.hour % 12 || 12}:${pad(z.minute)} ${z.hour < 12 ? "am" : "pm"}`;
}

/** "Fri 13 Nov 2026, 12:27 pm" (no zone name: it is always Sydney). */
export function dateTime(d: Date): string {
  const z = zoned(d);
  return `${z.weekday} ${z.day} ${MONTHS_SHORT[z.month - 1]} ${z.year}, ${clock(d)}`;
}

/** The long form for a tooltip: "Fri 13 Nov 2026, 12:27:24 pm AEDT". */
export function dateTimeFull(d: Date): string {
  const z = zoned(d);
  const zone = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "Sydney";
  return `${z.weekday} ${z.day} ${MONTHS_SHORT[z.month - 1]} ${z.year}, ${z.hour % 12 || 12}:${pad(z.minute)}:${pad(z.second)} ${z.hour < 12 ? "am" : "pm"} ${zone}`;
}

/** "Today, 12:27 pm" / "Yesterday, 4:11 pm" / "Mon 9 Nov, 4:11 pm" (the year only when it is not this year). */
export function dayAndTime(d: Date, now: Date): string {
  const z = zoned(d);
  const diff = dayNumber(zoned(now)) - dayNumber(z);
  if (diff === 0) return `Today, ${clock(d)}`;
  if (diff === 1) return `Yesterday, ${clock(d)}`;
  const year = z.year === zoned(now).year ? "" : ` ${z.year}`;
  return `${z.weekday} ${z.day} ${MONTHS_SHORT[z.month - 1]}${year}, ${clock(d)}`;
}

/** "Mon 9 Nov" */
export function dayLabel(d: Date): string {
  const z = zoned(d);
  return `${z.weekday} ${z.day} ${MONTHS_SHORT[z.month - 1]}`;
}

/** "5 min ago", "in 2 h", "just now". */
export function relativeTime(d: Date, now: Date): string {
  const s = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return s > 0 ? "in under a minute" : "just now";
  const text = abs < 5400 ? `${Math.max(1, Math.round(abs / 60))} min` : abs < 129_600 ? `${Math.round(abs / 3600)} h` : `${Math.round(abs / 86_400)} days`;
  return s > 0 ? `in ${text}` : `${text} ago`;
}

/** "42 ms", "1.2 s", "2 min 5 s". null -> "—". */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m} min ${s} s` : `${m} min`;
}

/** "$17.70" for dollars; any other currency is labelled: "11.17 USD". null -> "—". */
export function money(cents: number | null | undefined, currency = "AUD"): string {
  if (cents === null || cents === undefined) return "—";
  const abs = Math.abs(cents);
  const text = `${Math.floor(abs / 100).toLocaleString("en-AU")}.${pad(abs % 100)}`;
  const sign = cents < 0 ? "-" : "";
  return currency === "AUD" ? `${sign}$${text}` : `${sign}${text} ${currency}`;
}

/** US dollars (the AI spend): "$0.01". */
export const usd = (amount: number, digits = 2) => `$${amount.toFixed(digits)}`;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2026-11" -> "November 2026". */
export function monthLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  return m ? `${MONTHS_LONG[+m[2] - 1]} ${m[1]}` : key;
}
/** The Sydney month of a moment, "2026-11". */
export function monthKeyOf(d: Date): string {
  const z = zoned(d);
  return `${z.year}-${pad(z.month)}`;
}

/** The first characters of an id, for a compact monospace label. */
export const shortId = (id: string, n = 10) => (id.length > n ? `${id.slice(0, n)}…` : id);

const hourLabel = (hour: number, minute: number) => `${hour % 12 || 12}${minute ? `:${pad(minute)}` : ""}${hour < 12 ? "am" : "pm"}`;

/**
 * A cron expression in plain words. Handles the shapes Jarvis uses; anything else comes back as the cron itself.
 * `timezone` is the job's own zone: "Australia/Sydney" is shown as "Sydney"; no zone means the server's.
 */
export function scheduleToWords(cron: string, timezone?: string | null): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = f;
  const zone = timezone === TZ ? " Sydney" : "";
  const int = /^\d+$/;
  if (dom !== "*" || mon !== "*" || dow !== "*") return cron;
  if (min === "*" && hour === "*") return "every minute";
  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && hour === "*") return `every ${everyMin[1]} min`;
  if (int.test(min) && hour === "*") return +min === 0 ? "every hour" : `hourly at :${pad(+min)}`;
  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (int.test(min) && everyHours) return `every ${everyHours[1]} hours${+min ? ` at :${pad(+min)}` : ""}`;
  if (int.test(min) && int.test(hour)) return `daily ${hourLabel(+hour, +min)}${zone}`;
  return cron;
}
