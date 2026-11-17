import { startOfDay, zoned } from "../telegram/time";

// "Next 7 days: times Gurveer is busy." Only the times are shown, never what the events are (the fridge is in the kitchen).

export interface DayBusy {
  dow: string;
  num: number;
  month: string;
  today: boolean;
  /** "7:00 – 8:00 pm" */
  busy: string[];
}
interface Span {
  startIso: string;
  endIso: string;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Minutes after midnight (Sydney) of an instant on a day that starts at `dayStart`. */
const minutesIn = (d: Date, dayStart: Date) => Math.round((d.getTime() - dayStart.getTime()) / 60_000);

function clock(min: number): { text: string; pm: boolean } {
  const h24 = Math.floor(min / 60) % 24;
  const m = min % 60;
  return { text: `${h24 % 12 === 0 ? 12 : h24 % 12}:${String(m).padStart(2, "0")}`, pm: h24 >= 12 };
}
/** "7:00 – 8:00 pm", or "9:00 am – 1:00 pm" when it crosses noon. */
export function rangeLabel(startMin: number, endMin: number): string {
  const a = clock(startMin);
  const b = clock(endMin);
  return a.pm === b.pm ? `${a.text} – ${b.text} ${b.pm ? "pm" : "am"}` : `${a.text} ${a.pm ? "pm" : "am"} – ${b.text} ${b.pm ? "pm" : "am"}`;
}

export function weekBusy(spans: Span[], now: Date, days = 7): DayBusy[] {
  const z = zoned(now);
  const out: DayBusy[] = [];
  for (let i = 0; i < days; i++) {
    const start = startOfDay(z.year, z.month, z.day + i);
    const next = startOfDay(z.year, z.month, z.day + i + 1);
    const lengthMin = minutesIn(next, start); // 1440, or 1380 / 1500 on a daylight saving day
    // The part of each event that falls on this day, sorted, with overlapping ones joined.
    const parts = spans
      .map((s) => [Math.max(minutesIn(new Date(s.startIso), start), 0), Math.min(minutesIn(new Date(s.endIso), start), lengthMin)] as [number, number])
      .filter(([a, b]) => b > a)
      .sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const p of parts) {
      const last = merged[merged.length - 1];
      if (last && p[0] <= last[1]) last[1] = Math.max(last[1], p[1]);
      else merged.push([p[0], p[1]]);
    }
    const noon = new Date(start.getTime() + 12 * 3_600_000);
    const zn = zoned(noon);
    out.push({ dow: DOW[new Date(Date.UTC(zn.year, zn.month - 1, zn.day)).getUTCDay()], num: zn.day, month: MONTH[zn.month - 1], today: i === 0, busy: merged.map(([a, b]) => rangeLabel(a, b)) });
  }
  return out;
}
