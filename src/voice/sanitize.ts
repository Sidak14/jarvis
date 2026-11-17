import { MAX_TEXT_CHARS } from "./settings";

// Everything a tool returns is DATA for the model, never instructions. Free text that came from outside (plan titles, chat
// names, merchants, calendar titles) can contain anything, so it is cut short, flattened to one line, and wrapped in quotes.

/** One line, no control characters or quote marks, at most `max` characters. */
export function clean(text: unknown, max = MAX_TEXT_CHARS): string {
  const flat = String(text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/[`"“”]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** For text a tool speaks or hands over: cleaned and in quotes, so it reads as a quotation, not as an order. */
export const quoted = (text: unknown, max = MAX_TEXT_CHARS): string => `"${clean(text, max)}"`;

/** Cleans every string anywhere in a structure (depth and size limited). Tools cannot forget to. */
export function sanitizeData(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return clean(value, MAX_TEXT_CHARS * 2);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 5) return null;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeData(v, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([k, v]) => [clean(k, 40), sanitizeData(v, depth + 1)]));
  }
  return null;
}
