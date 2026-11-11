/** "$1,234.56" for AUD, "11.17 USD" for anything else. */
export function money(cents: number, currency: string): string {
  const n = (cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "AUD" ? `$${n}` : `${n} ${currency}`;
}

/** "5m ago", "3h ago", "2d ago". */
export function ago(iso: string | null | undefined, now: Date): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** One line of plain text: no control characters, clipped. Merchant names are data, not markup. */
export function oneLine(text: string | null | undefined, max = 80): string {
  const t = (text ?? "").replace(/[\u0000-\u001f]+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
