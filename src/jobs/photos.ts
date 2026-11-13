import path from "node:path";
import { config } from "../config";
import { db } from "../db";
import { registerJob } from "../runner";
import { notify } from "../telegram";
import { createBeeperReader } from "../plans/beeper";
import { createGraphClient, type GraphClient } from "../photos/graph";
import { oneDriveAuth } from "../photos/index";
import { runPhotos } from "../photos/pipeline";
import { COOLDOWN_ALERT_MS, KEEPALIVE_HOURS, POLL_CRON, POLL_JOB, TOKEN_WARN_DAYS } from "../photos/settings";
import { getState, setState } from "../photos/store";

const tmpDir = path.join(path.dirname(config.DB_PATH), "photo-tmp");

/** Never put a token in an error, state or alert. */
const scrub = (message: string) => {
  let m = message;
  for (const secret of [config.BEEPER_ACCESS_TOKEN]) if (secret) m = m.split(secret).join("***");
  return m.slice(0, 300);
};

/**
 * Keep the Microsoft login alive (use it at least once a day, which renews it) and tell you early if it is failing.
 * Returns why OneDrive can not be used right now, or null when it is ready.
 */
async function checkOneDrive(now: Date): Promise<string | null> {
  if (!oneDriveAuth.isConfigured()) return "OneDrive is not set up (MS_CLIENT_ID missing). See README: Event photos";
  const status = oneDriveAuth.status();
  if (!status.connected && !status.needsLogin) return "OneDrive is not signed in. Run: npm run photos:setup";
  if (status.needsLogin) {
    notify("⚠️ Event photos: the OneDrive sign-in expired or was revoked. Run npm run photos:setup on the Mac mini to sign in again.", { dedupeKey: "photos-signin", cooldownMs: COOLDOWN_ALERT_MS });
    return "OneDrive sign-in expired. Run: npm run photos:setup";
  }
  const last = status.refreshedAt ? Date.parse(status.refreshedAt) : 0;
  if (now.getTime() - last > KEEPALIVE_HOURS * 3_600_000) {
    try {
      await oneDriveAuth.getAccessToken(true);
    } catch (err) {
      const after = oneDriveAuth.status();
      notify(`⚠️ Event photos: refreshing the OneDrive sign-in failed${after.needsLogin ? " and it needs signing in again (npm run photos:setup)" : ""}: ${scrub((err as Error).message)}`, {
        dedupeKey: "photos-signin", cooldownMs: COOLDOWN_ALERT_MS,
      });
      return scrub((err as Error).message);
    }
  }
  const after = oneDriveAuth.status();
  if (after.daysLeft !== null && after.daysLeft < TOKEN_WARN_DAYS) {
    notify(`⚠️ Event photos: the OneDrive sign-in has about ${Math.max(0, after.daysLeft)} days left. Run npm run photos:setup to renew it.`, { dedupeKey: "photos-signin-expiring", cooldownMs: 24 * 3_600_000 });
  }
  return null;
}

export function registerPhotos(): void {
  // Quiet: a run that found nothing is not written to the run history (a failure always is).
  registerJob(
    POLL_JOB,
    POLL_CRON,
    async ({ log }) => {
      const token = config.BEEPER_ACCESS_TOKEN;
      if (!token) return; // Beeper is not set up: the plans status says so
      const now = new Date();

      // Live mode needs OneDrive and the confirmed Uni Events folder. Dry run needs neither.
      let graph: GraphClient | null = null;
      let graphProblem: string | null = null;
      if (!config.PHOTOS_DRY_RUN) {
        graphProblem = await checkOneDrive(now);
        const rootId = getState(db, "uni_events_id");
        if (!graphProblem && !rootId) graphProblem = "the Uni Events folder is not confirmed yet. Run: npm run photos:setup";
        if (!graphProblem && rootId) graph = createGraphClient({ getToken: () => oneDriveAuth.getAccessToken(), rootId });
        setState(db, "last_problem", graphProblem, now);
      }

      const reader = createBeeperReader({ accessToken: token, baseURL: config.BEEPER_BASE_URL, mediaRoot: config.BEEPER_MEDIA_ROOT });
      const result = await runPhotos({
        db, reader, graph, graphProblem, notify, dryRun: config.PHOTOS_DRY_RUN, windowStart: config.PHOTO_WINDOW_START,
        minRun: config.PHOTOS_MIN_RUN, gapMs: config.PHOTOS_RUN_GAP_MINUTES * 60_000, tmpDir, now, log,
      });
      setState(db, "last_run_at", now.toISOString(), now);
      setState(db, "last_run_error", result.errors[0] ? scrub(result.errors[0]) : null, now);
      if (result.saved || result.queued || result.failed) log(`photos: ${result.queued} queued, ${result.saved} saved, ${result.failed} failed`);
      if (result.errors.length) throw new Error(scrub(result.errors.slice(0, 3).join("; ")));
    },
    { quiet: true },
  );
}
