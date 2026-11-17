import { zoned } from "../telegram/time";

// Words for a voice: numbers and money read out, times and durations said the way a person would. No digits-with-symbols,
// because the text-to-speech reads "$17.70" badly and "seventeen dollars seventy" well.

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 0 to 999,999 in words ("four hundred and twelve"). Bigger numbers are said as digits (they should not happen). */
export function words(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred` + (n % 100 ? ` and ${words(n % 100)}` : "");
  const rest = n % 1000;
  return `${words(Math.floor(n / 1000))} thousand` + (rest ? (rest < 100 ? ` and ${words(rest)}` : ` ${words(rest)}`) : "");
}

/** 1770 -> "seventeen dollars seventy"; 1700 -> "seventeen dollars"; 70 -> "seventy cents"; 100 -> "one dollar". */
export function spokenMoney(cents: number): string {
  const sign = cents < 0 ? "minus " : "";
  const c = Math.abs(Math.round(cents));
  const dollars = Math.floor(c / 100);
  const rest = c % 100;
  if (dollars === 0) return `${sign}${rest === 0 ? "zero dollars" : `${words(rest)} cent${rest === 1 ? "" : "s"}`}`;
  return `${sign}${words(dollars)} dollar${dollars === 1 ? "" : "s"}${rest ? ` ${words(rest)}` : ""}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${words(n)} ${n === 1 ? one : many}`;

/** "12 minutes", "2 hours 5 minutes", "3 days": how long something has been the case. */
export function spokenDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 1) return "less than a minute";
  if (mins < 60) return plural(mins, "minute");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${plural(hours, "hour")}${mins % 60 ? ` ${plural(mins % 60, "minute")}` : ""}`;
  return plural(Math.floor(hours / 24), "day");
}

/** "3pm", "3:30pm", "noon" (Sydney time). */
export function spokenTime(d: Date): string {
  const z = zoned(d);
  if (z.hour === 12 && z.minute === 0) return "noon";
  if (z.hour === 0 && z.minute === 0) return "midnight";
  const h = z.hour % 12 === 0 ? 12 : z.hour % 12;
  return `${h}${z.minute ? `:${String(z.minute).padStart(2, "0")}` : ""}${z.hour >= 12 ? "pm" : "am"}`;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** "today", "tomorrow", or "Saturday" for a date within the week, else "Sat 21 Nov". */
export function spokenDay(date: Date, now: Date): string {
  const key = (d: Date) => {
    const z = zoned(d);
    return Date.UTC(z.year, z.month - 1, z.day) / 86_400_000;
  };
  const diff = key(date) - key(now);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff > 1 && diff < 7) return DAYS[new Date(key(date) * 86_400_000).getUTCDay()];
  const z = zoned(date);
  return `${DAYS[new Date(key(date) * 86_400_000).getUTCDay()]} ${words(z.day)}`;
}

/** Up to `max` items, then "and N more" (or an offer to say more). */
export function listSpoken(items: string[], max = 3): string {
  if (items.length <= max) return items.join(", ").replace(/, ([^,]*)$/, items.length > 1 ? " and $1" : ", $1");
  return `${items.slice(0, max).join(", ")}, and ${words(items.length - max)} more`;
}
