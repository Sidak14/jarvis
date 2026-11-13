import fs from "node:fs";
import path from "node:path";
import { loadAllowlist } from "./allowlist";
import { createBeeperReader } from "./beeper";
import { ALLOWLIST_FILE } from "./settings";

// `npm run chats`: lists your Beeper chats (most recent first) so you can pick which ones to put
// in data/plans-chats.json. Read-only. Never prints the token.

const root = path.resolve(__dirname, "..", "..");
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

async function main(): Promise<void> {
  const token = process.env.BEEPER_ACCESS_TOKEN;
  const baseURL = process.env.BEEPER_BASE_URL ?? "http://127.0.0.1:23373";
  if (!token) {
    console.error("BEEPER_ACCESS_TOKEN is not set in .env (Beeper Desktop > Settings > Integrations).");
    process.exit(1);
  }
  const reader = createBeeperReader({ accessToken: token, baseURL });
  try {
    const { accounts } = await reader.check();
    console.log(`Connected to Beeper Desktop at ${baseURL} (${accounts} accounts)\n`);
  } catch (err) {
    console.error(`Could not reach Beeper Desktop at ${baseURL}: ${(err as Error).message.split(token).join("***")}`);
    console.error("Is Beeper Desktop running and logged in, with the Desktop API switched on?");
    process.exit(1);
  }

  const dataDir = process.env.DB_PATH ? path.dirname(path.resolve(root, process.env.DB_PATH)) : path.join(root, "data");
  const allowed = new Set(loadAllowlist(dataDir).chats.map((c) => c.id));
  const chats = await reader.listChats();
  console.log(`${chats.length} chats, most recent first. [x] = already on your allowlist\n`);
  for (const c of chats) {
    console.log(`${allowed.has(c.id) ? "[x]" : "[ ]"} ${c.type === "group" ? "GROUP" : "DM   "}  ${c.name}`);
    console.log(`      id: ${c.id}`);
  }
  console.log(`\nTo choose chats, create ${path.join(dataDir, ALLOWLIST_FILE)}:`);
  console.log(`{ "chats": [ { "id": "<id from above>", "name": "Friendly name" } ] }`);
  console.log("Groups and DMs both work. DMs with members of an allowlisted group are included automatically.");
}

main().catch((err) => {
  console.error(`Failed: ${(err as Error).message}`);
  process.exit(1);
});
