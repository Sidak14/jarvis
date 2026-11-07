import { serve } from "@hono/node-server";
import { HOST, config, redactedConfig } from "./config";
import { app } from "./app";
import { closeDb } from "./db";
import { registerHeartbeat } from "./jobs/heartbeat";
import { stopAllJobs } from "./runner";

console.log("[jarvis] config:", JSON.stringify(redactedConfig()));

registerHeartbeat();

const server = serve({ fetch: app.fetch, hostname: HOST, port: config.PORT }, (info) => {
  console.log(`[jarvis] listening on http://${info.address}:${info.port}`);
});

// A bug in one job or request must not take the server down.
process.on("unhandledRejection", (err) => console.error("[jarvis] unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("[jarvis] uncaughtException:", err));

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`[jarvis] ${signal} received, shutting down`);
  stopAllJobs();
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  (server as unknown as import("node:http").Server).closeAllConnections();
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => shutdown(sig));
}
