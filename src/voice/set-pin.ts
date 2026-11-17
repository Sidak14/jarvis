import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config";
import { hashPin, normalisePin } from "./pin";

// `npm run voice:set-pin`: asks for the PIN in the terminal (hidden, twice) and saves only its hash in .env.
// Never type the PIN into a chat.

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let text = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(text);
          return;
        }
        if (ch === "\u0003") process.exit(1); // ctrl-c
        if (ch === "\u007f") text = text.slice(0, -1);
        else text += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY) throw new Error("run this in a terminal (it asks for the PIN without showing it)");
  const first = normalisePin(await ask("New PIN (6 digits recommended, 4 to 8): "));
  if (first.length < 4 || first.length > 8) throw new Error("the PIN must be 4 to 8 digits");
  const second = normalisePin(await ask("Again: "));
  if (first !== second) throw new Error("the two did not match; nothing was changed");

  const envPath = path.join(ROOT, ".env");
  const line = `VOICE_PIN_HASH=${hashPin(first)}\n`;
  let env = fs.readFileSync(envPath, "utf8");
  env = /^VOICE_PIN_HASH=.*$/m.test(env) ? env.replace(/^VOICE_PIN_HASH=.*\n?/m, line) : `${env.replace(/\n*$/, "\n")}${line}`;
  fs.writeFileSync(envPath, env, { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
  console.log("PIN saved (as a hash). Restart Jarvis for it to take effect.");
}

main().catch((err) => {
  console.error(`voice:set-pin: ${(err as Error).message}`);
  process.exit(1);
});
