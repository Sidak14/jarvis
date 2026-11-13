import { PageLayout } from "./ui/components";
import { raw } from "./ui/html";

/** Escape text before putting it in HTML. Use it for every value that comes from data. */
export const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/**
 * The page shell for the small notice pages (login results and errors). They bring their own heading, so the
 * shell leaves its own title out. `body` must already be escaped HTML. The real pages use PageLayout (src/ui).
 */
export function layout(title: string, body: string): string {
  return PageLayout({ title, active: null, body: raw(body), now: new Date(), bare: true });
}
