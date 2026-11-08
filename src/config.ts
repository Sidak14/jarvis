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
  // Public hostname of the Cloudflare tunnel (used to accept dashboard requests from it).
  PUBLIC_HOST: z.string().min(1).default("jarvis.gurveerkhalsa.com"),

  // Spotify. Optional so the server still starts before you add them;
  // the spotify-likes job reports a clear error until they are set.
  SPOTIFY_CLIENT_ID: z.string().min(1).optional(),
  SPOTIFY_CLIENT_SECRET: z.string().min(1).optional(),
  // Where Spotify sends the browser after login. Must match one registered in the Spotify
  // dashboard exactly, and end in /spotify/callback.
  // Default: https://<PUBLIC_HOST>/spotify/callback, so login works from any device.
  SPOTIFY_REDIRECT_URI: z
    .url()
    .refine((u) => new URL(u).pathname === "/spotify/callback", "must end with /spotify/callback")
    .optional(),
  // Safe by default: log what would be liked, but don't like anything.
  SPOTIFY_DRY_RUN: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Print only which keys are wrong and why. Never echo the values.
  for (const issue of parsed.error.issues) {
    console.error(`config error: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = {
  ...parsed.data,
  SPOTIFY_REDIRECT_URI:
    parsed.data.SPOTIFY_REDIRECT_URI ?? `https://${parsed.data.PUBLIC_HOST}/spotify/callback`,
};

/** Safe-to-log view of the config: secrets are masked. */
export function redactedConfig(): Record<string, string | number | boolean | undefined> {
  return {
    ...config,
    WEBHOOK_SECRET: "***",
    SPOTIFY_CLIENT_ID: config.SPOTIFY_CLIENT_ID ? "***" : undefined,
    SPOTIFY_CLIENT_SECRET: config.SPOTIFY_CLIENT_SECRET ? "***" : undefined,
  };
}
