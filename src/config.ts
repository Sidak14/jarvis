import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const ROOT = path.resolve(__dirname, "..");
export const HOST = "127.0.0.1"; // fixed on purpose: never listen on other interfaces

const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const schema = z.object({
  WEBHOOK_SECRET: z.string().min(16, "must be at least 16 characters"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DB_PATH: z.string().min(1).default(path.join(ROOT, "data", "jarvis.db")),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Print only which keys are wrong and why. Never echo the values.
  for (const issue of parsed.error.issues) {
    console.error(`config error: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;

/** Safe-to-log view of the config: secrets are masked. */
export function redactedConfig(): Record<string, string | number> {
  return { ...config, WEBHOOK_SECRET: "***" };
}
