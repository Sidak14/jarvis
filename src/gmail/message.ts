// Turns a Gmail API message into plain text. The text is only held in memory while we work on it;
// it is never written to the database or the logs.

export interface EmailMessage {
  id: string;
  from: string;
  subject: string;
  receivedAt: string; // ISO, from Gmail's internalDate
  text: string;
}

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

/** All parts of one mime type, depth first. */
function findParts(part: Part | undefined, mime: string, out: string[] = []): string[] {
  if (!part) return out;
  if (part.mimeType === mime && part.body?.data) out.push(decode(part.body.data));
  for (const child of part.parts ?? []) findParts(child, mime, out);
  return out;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export function parseMessage(json: {
  id?: string;
  internalDate?: string;
  payload?: Part;
}): EmailMessage {
  const header = (name: string) =>
    json.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
  const plain = findParts(json.payload, "text/plain").join("\n").trim();
  const text = plain || htmlToText(findParts(json.payload, "text/html").join("\n"));
  const ms = Number(json.internalDate);
  return {
    id: String(json.id ?? ""),
    from: header("from"),
    subject: header("subject"),
    receivedAt: new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now()).toISOString(),
    text,
  };
}
