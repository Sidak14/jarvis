import fs from "node:fs";
import path from "node:path";
import { config, ROOT } from "../config";
import { loadEntities } from "./entities";
import { buildRegistry } from "./tools";

// Only the tools' names and argument shapes are needed here, so no database or Home Assistant is touched.
const registry = buildRegistry({ db: null as never, entities: loadEntities(), ha: null, calendar: () => null, writes: () => "dry" });

// `npm run voice:push`: make Vapi match voice/assistant.json plus the tool registry. The code is the source of truth:
// this creates or updates the assistant (and points the phone number at Jarvis), and saves the ids in voice/.vapi-ids.json.
//   npm run voice:push              do it
//   npm run voice:push -- --dry     print what would be sent (secrets hidden), call nothing

const API = "https://api.vapi.ai";
const IDS_FILE = path.join(ROOT, "voice", ".vapi-ids.json");
const dry = process.argv.includes("--dry");

function readIds(): { assistantId?: string } {
  try {
    return JSON.parse(fs.readFileSync(IDS_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** How Vapi proves itself to Jarvis: a saved credential if there is one, else the same bearer secret as a header. */
function serverAuth(): { credentialId: string } | { headers: Record<string, string> } {
  if (config.VAPI_CREDENTIAL_ID) return { credentialId: config.VAPI_CREDENTIAL_ID };
  return { headers: { Authorization: `Bearer ${config.VAPI_WEBHOOK_SECRET}` } };
}

export function buildAssistant(): Record<string, unknown> {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "voice", "assistant.json"), "utf8")) as Record<string, unknown> & { model: Record<string, unknown> };
  const url = `https://${config.PUBLIC_HOST}${config.VOICE_PATH_PREFIX}`;
  const { systemPrompt, ...model } = base.model as { systemPrompt: string } & Record<string, unknown>;
  const server = (path: string) => ({ url: `${url}${path}`, timeoutSeconds: 10, ...serverAuth() });
  return {
    ...base,
    model: {
      ...model,
      messages: [{ role: "system", content: systemPrompt }],
      tools: registry.definitions().map((t) => ({ type: "function", function: t, server: server("/tools") })),
    },
    server: server("/events"),
  };
}

async function vapi(method: string, route: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { Authorization: `Bearer ${config.VAPI_API_KEY}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vapi ${method} ${route} answered ${res.status}: ${text.slice(0, 600)}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** The same JSON with anything secret hidden, for printing. */
const hide = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === "Authorization" ? "Bearer ***" : k === "credentialId" ? "***" : x)));

async function main(): Promise<void> {
  const assistant = buildAssistant();
  if (dry) {
    console.log(JSON.stringify(hide(assistant), null, 2));
    return;
  }
  if (!config.VAPI_API_KEY) throw new Error("VAPI_API_KEY is not set in .env");
  if (!config.VAPI_WEBHOOK_SECRET) throw new Error("VAPI_WEBHOOK_SECRET is not set in .env");

  const ids = readIds();
  let assistantId = ids.assistantId;
  if (assistantId) {
    await vapi("PATCH", `/assistant/${assistantId}`, assistant);
    console.log(`updated assistant ${assistantId}`);
  } else {
    const created = await vapi("POST", "/assistant", assistant);
    assistantId = String(created.id);
    fs.writeFileSync(IDS_FILE, JSON.stringify({ ...ids, assistantId }, null, 2) + "\n", { mode: 0o600 });
    console.log(`created assistant ${assistantId}`);
  }

  // Inbound calls: no fixed assistant on the number, so Vapi asks Jarvis "who is calling?" (assistant-request) and Jarvis
  // answers with the assistant only for my own number. A stranger hears a refusal and never reaches the model.
  if (config.VAPI_PHONE_NUMBER_ID) {
    const number = await vapi("GET", `/phone-number/${config.VAPI_PHONE_NUMBER_ID}`);
    console.log(`phone number: ${String(number.number ?? "?")}, currently ${number.assistantId ? "tied to an assistant" : "no assistant"}`);
    await vapi("PATCH", `/phone-number/${config.VAPI_PHONE_NUMBER_ID}`, {
      assistantId: null,
      server: { url: `https://${config.PUBLIC_HOST}${config.VOICE_PATH_PREFIX}/events`, timeoutSeconds: 8, ...serverAuth() },
    });
    console.log("phone number now asks Jarvis who is calling");
  }
}

main().catch((err) => {
  console.error(`voice:push failed: ${(err as Error).message}`);
  process.exit(1);
});
