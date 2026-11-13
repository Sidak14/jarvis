import fs from "node:fs";

// What a downloaded file really is. Files from chats are UNTRUSTED, so they are only ever treated as bytes:
// the first few bytes are compared with the known signatures of common photo and video formats, nothing is
// opened, decoded, parsed or run. The extension comes from what the bytes are, never from the sender's file name.

export interface Sniffed {
  category: "image" | "video";
  ext: string;
  mime: string;
}

export function sniff(head: Buffer): Sniffed | null {
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  const ascii = (from: number, to: number) => head.subarray(from, to).toString("latin1");

  if (starts(0xff, 0xd8, 0xff)) return { category: "image", ext: "jpg", mime: "image/jpeg" };
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { category: "image", ext: "png", mime: "image/png" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { category: "image", ext: "webp", mime: "image/webp" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "AVI ") return { category: "video", ext: "avi", mime: "video/x-msvideo" };
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return { category: "video", ext: "webm", mime: "video/webm" };
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)$/.test(brand)) return { category: "image", ext: brand === "avif" ? "avif" : "heic", mime: "image/heif" };
    if (brand === "qt  ") return { category: "video", ext: "mov", mime: "video/quicktime" };
    return { category: "video", ext: "mp4", mime: "video/mp4" };
  }
  return null; // GIFs, PDFs, executables, anything else
}

export type FileCheck = { ok: true; sniffed: Sniffed } | { ok: false; reason: string };

/**
 * Is this downloaded file a photo or video? The type the chat app declared (if any) must be image/* or video/*,
 * and the bytes must agree with it.
 */
export function checkFile(filePath: string, declaredMime: string | null | undefined): FileCheck {
  if (declaredMime && !/^(image|video)\//i.test(declaredMime)) return { ok: false, reason: `declared type is ${declaredMime.slice(0, 40)}, not image/* or video/*` };
  const fd = fs.openSync(filePath, "r");
  const head = Buffer.alloc(16);
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  const sniffed = sniff(head);
  if (!sniffed) return { ok: false, reason: "the bytes are not a known photo or video format" };
  if (declaredMime && !declaredMime.toLowerCase().startsWith(`${sniffed.category}/`)) {
    return { ok: false, reason: `declared ${declaredMime.slice(0, 40)} but the bytes are ${sniffed.category}` };
  }
  return { ok: true, sniffed };
}
