import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { MS_GRAPH_BASE, MS_SCOPES, ROOT_FOLDER_NAME } from "./settings";
import { OneDriveAuth } from "./onedrive-auth";

// `npm run photos:setup -- "<OneDrive folder link, or a path like Pictures/Uni Events>"`
//   1. signs in to your personal Microsoft account (device code: you type a short code at a web address),
//   2. finds the Uni Events folder through Microsoft Graph (one GET for that exact path, nothing is listed),
//   3. shows you what it found and asks you to confirm before it is ever used.
// The sign-in code is shown on THIS screen only. Nothing secret is printed or written anywhere except the database.

const root = path.resolve(__dirname, "..", "..");
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

/** "https://onedrive.live.com/my?id=%2Fpersonal%2F<id>%2FDocuments%2FPictures%2FUni%20Events&..." -> "Pictures/Uni Events". */
export function folderPathFromInput(input: string): string | null {
  const text = input.trim();
  if (!/^https?:\/\//i.test(text)) return text.replace(/^\/+|\/+$/g, "") || null;
  const id = new URL(text).searchParams.get("id");
  if (!id) return null;
  const after = /\/Documents\/(.+)$/i.exec(decodeURIComponent(id));
  return after ? after[1].replace(/\/+$/, "") : null;
}

async function main(): Promise<void> {
  // Imported late: these read .env and open the database.
  const { config } = await import("../config");
  const { db } = await import("../db");
  const { setState } = await import("./store");

  if (!config.MS_CLIENT_ID) {
    console.error("MS_CLIENT_ID is not set in .env. Register the Azure app first (README: Event photos).");
    process.exit(1);
  }
  const folderPath = folderPathFromInput(process.argv[2] ?? "");
  if (!folderPath) {
    console.error('Give the Uni Events folder as a OneDrive link or a path, e.g.  npm run photos:setup -- "Pictures/Uni Events"');
    process.exit(1);
  }

  const auth = new OneDriveAuth(db, config.MS_CLIENT_ID);
  console.log(`\nThis sign-in lets Jarvis: ${MS_SCOPES.join(" + ")}.`);
  console.log("Files.ReadWrite means Microsoft will let this app read and write files in your OneDrive.");
  console.log(`Jarvis's code only ever writes under "${ROOT_FOLDER_NAME}" (it has no delete, list or search function). offline_access keeps it signed in.\n`);

  const dc = await auth.startDeviceCode();
  console.log(`1. Open ${dc.verification_uri}`);
  console.log(`2. Type this code: ${dc.user_code}`);
  console.log(`3. Sign in with your PERSONAL Microsoft account and accept.\nWaiting (the code works for ${Math.round(dc.expires_in / 60)} minutes)...`);
  await auth.finishDeviceCode(dc);
  console.log("Signed in.\n");

  // One GET for exactly this path. (Not a search: nothing outside it is looked at.)
  const token = await auth.getAccessToken();
  const url = `${MS_GRAPH_BASE}/me/drive/root:/${folderPath.split("/").map(encodeURIComponent).join("/")}?$select=id,name,webUrl,folder,parentReference`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) {
    console.error(`No folder at "${folderPath}" in your OneDrive. Check the path (it starts below "Documents" in the web address) and run this again.`);
    process.exit(1);
  }
  const item = (await res.json().catch(() => ({}))) as { id?: string; name?: string; webUrl?: string; folder?: unknown; parentReference?: { path?: string } };
  if (!res.ok || !item.id || !item.folder) {
    console.error(`Could not read that folder (HTTP ${res.status}${item.folder ? "" : ", or it is not a folder"}).`);
    process.exit(1);
  }
  console.log("Found this folder:");
  console.log(`  name:   ${item.name}`);
  console.log(`  where:  ${item.parentReference?.path ?? "?"}/${item.name}`);
  console.log(`  link:   ${item.webUrl}`);
  console.log(`Photos will be saved into  ${item.name} / <chat name> / <event name> <DD Month YYYY>\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Is this the right Uni Events folder? (yes/no) ")).trim().toLowerCase();
  rl.close();
  if (answer !== "yes" && answer !== "y") {
    console.log("Not saved. Nothing will be uploaded until a folder is confirmed.");
    process.exit(1);
  }
  setState(db, "uni_events_id", item.id);
  setState(db, "uni_events_name", `${item.parentReference?.path ?? ""}/${item.name}`);
  console.log("Saved. Uploads stay off until you set PHOTOS_DRY_RUN=false in .env and restart.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
