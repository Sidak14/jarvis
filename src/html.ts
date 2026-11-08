/** Escape text before putting it in HTML. Use it for every value that comes from data. */
export const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const STYLE = `
  body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:64rem;padding:0 1rem}
  table{border-collapse:collapse;width:100%;margin-bottom:2rem}
  th,td{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #8884}
  pre{background:#8881;padding:.75rem;overflow:auto;white-space:pre-wrap;border-radius:6px}
  button{font:inherit;padding:.4rem .9rem;cursor:pointer}
  .success,.liked{color:#1a7f37}.failure,.error{color:#cf222e}.running,.pending{color:#9a6700}
  .muted{opacity:.7}
`;

/** Shared page shell for the dashboard pages. `body` must already be escaped HTML. */
export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body>
${body}
</body></html>`;
}
