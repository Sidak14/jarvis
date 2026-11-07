import { registerJob } from "../runner";

export function registerHeartbeat(): void {
  registerJob("heartbeat", "*/5 * * * *", ({ log }) => {
    log(`heartbeat ok, uptime ${Math.round(process.uptime())}s`);
  });
}
