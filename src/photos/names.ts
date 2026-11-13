import { MAX_NAME_CHARS } from "./settings";

// Folder and file names. Everything that came from a chat (chat title, plan title) is untrusted text,
// so it is cleaned here before it is ever used as an OneDrive name.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-07-09" -> "09 July 2026". Returns null for anything that is not a real calendar day. */
export function formatEventDate(dateKey: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey ?? "");
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || mo > 12 || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return `${String(d).padStart(2, "0")} ${MONTHS[mo - 1]} ${y}`;
}

// OneDrive does not allow these characters, and Windows reserves some whole names.
const BAD_CHARS = /["*:<>?/\\|]/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|desktop\.ini|\.lock|_vti_.*)$/i;

/** A safe OneDrive file/folder name: no forbidden characters, no control characters, no trailing dots or spaces, capped. */
export function sanitizeName(raw: string | null | undefined, fallback = "Untitled", max = MAX_NAME_CHARS): string {
  let s = (raw ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, " ")
    .replace(BAD_CHARS, "-")
    .replace(/\s+/g, " ");
  s = s.replace(/^~\$/, "");
  s = Array.from(s).slice(0, max).join(""); // by character, so an emoji is never cut in half
  s = s.replace(/^[ .]+|[ .]+$/g, "");
  if (!s) return fallback;
  return RESERVED.test(s) ? `_${s}` : s;
}

/** The chat folder: the chat's title (cleaned). */
export const chatFolderName = (chatTitle: string | null | undefined) => sanitizeName(chatTitle, "Chat");

/** The event folder: "<plan title> <DD Month YYYY>", e.g. "Ice skating 19 July 2026". The date always survives the length cap. */
export function eventFolderName(title: string | null | undefined, dateKey: string | null | undefined): string {
  const date = formatEventDate(dateKey) ?? "no date";
  const name = sanitizeName(title, "Event", MAX_NAME_CHARS - date.length - 1);
  return sanitizeName(`${name} ${date}`, "Event");
}

const SYDNEY = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** "2026-07-19_143005_2.jpg": the message's Sydney time, then a counter. The sender's own file name is never used. */
export function mediaFileName(at: Date, n: number, ext: string): string {
  const p = Object.fromEntries(SYDNEY.formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}_${p.hour}${p.minute}${p.second}_${n}.${ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin"}`;
}

/** Just the "YYYY-MM-DD_HHMMSS" part of mediaFileName (what the counter is counted against). */
export const fileStamp = (at: Date) => mediaFileName(at, 0, "x").replace(/_0\.x$/, "");
