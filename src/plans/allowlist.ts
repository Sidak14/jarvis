import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ALLOWLIST_FILE } from "./settings";

// The chats Jarvis may read: data/plans-chats.json, a list of Beeper chat ids with friendly names.
//   { "chats": [ { "id": "!abc:beeper.local", "name": "Footy boys" } ] }
// Find ids with `npm run chats`. The file is outside git (data/ is ignored).

const fileSchema = z.object({
  chats: z.array(z.object({ id: z.string().min(1).max(300), name: z.string().min(1).max(80) })).max(300),
});
export type AllowedChat = z.infer<typeof fileSchema>["chats"][number];

export function allowlistPath(dataDir: string): string {
  return path.join(dataDir, ALLOWLIST_FILE);
}

/** Never throws: a missing file is an empty list, a broken one is reported as `error`. */
export function loadAllowlist(dataDir: string): { chats: AllowedChat[]; error: string | null } {
  const file = allowlistPath(dataDir);
  if (!fs.existsSync(file)) return { chats: [], error: null };
  try {
    const parsed = fileSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    const seen = new Set<string>();
    return { chats: parsed.chats.filter((c) => !seen.has(c.id) && seen.add(c.id)), error: null };
  } catch (err) {
    return { chats: [], error: `${ALLOWLIST_FILE} is not valid: ${(err as Error).message.slice(0, 150)}` };
  }
}
