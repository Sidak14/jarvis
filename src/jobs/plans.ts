import path from "node:path";
import { createGatewayLlm } from "../ai/llm";
import { config } from "../config";
import { db } from "../db";
import { registerJob } from "../runner";
import { notify } from "../telegram";
import { runActions, type ActionDeps } from "../plans/actions";
import { createBeeperReader } from "../plans/beeper";
import { createCalendarClient } from "../plans/calendar";
import { runPlanCommand } from "../plans/commands";
import { createHaikuDetector } from "../plans/detect";
import { calendarAuth } from "../plans/index";
import { pollChats } from "../plans/ingest";
import { restoreFromFile, writePlanFiles } from "../plans/markdown";
import { runDetection } from "../plans/pipeline";
import { COOLDOWN_BEEPER_MS, POLL_CRON, POLL_JOB } from "../plans/settings";
import { setState } from "../plans/store";

const dataDir = path.dirname(config.DB_PATH);

function actionDeps(log: (m: string) => void = () => {}): ActionDeps {
  return {
    db,
    calendar: calendarAuth.isConnected() ? createCalendarClient(calendarAuth) : null,
    notify,
    dryRun: config.PLANS_DRY_RUN,
    now: new Date(),
    log,
  };
}

/** For the Telegram bot: /undo, /addback, /addanyway, /keep, /remove, /plans. null = not a plan command. */
export const planCommand = (word: string, arg: string): Promise<string | null> => runPlanCommand(actionDeps(), word, arg);

/** Never put the token in an error, state or alert. */
const scrub = (message: string) => (config.BEEPER_ACCESS_TOKEN ? message.split(config.BEEPER_ACCESS_TOKEN).join("***") : message).slice(0, 300);

export function registerPlans(): void {
  // Disaster recovery: an empty database but a plans.md from before -> load it back.
  try {
    const restored = restoreFromFile(db, dataDir);
    if (restored) console.log(`[plans] restored ${restored} plan(s) from plans.md`);
  } catch (err) {
    console.error(`[plans] could not read plans.md: ${(err as Error).message}`);
  }

  // Quiet: a run that found nothing is not written to the run history (a failure always is).
  registerJob(
    POLL_JOB,
    POLL_CRON,
    async ({ log }) => {
      const token = config.BEEPER_ACCESS_TOKEN;
      if (!token) return; // not set up yet: the status page says so

      // 1. Is Beeper reachable? If not, say so on the status page AND on Telegram (once per cooldown).
      const reader = createBeeperReader({ accessToken: token, baseURL: config.BEEPER_BASE_URL });
      try {
        const { accounts } = await reader.check();
        setState(db, "accounts", String(accounts));
        setState(db, "last_poll_ok_at", new Date().toISOString());
        setState(db, "last_error", null);
      } catch (err) {
        const reason = `Beeper Desktop is not reachable at ${config.BEEPER_BASE_URL} (is it running, logged in, with the Desktop API on?): ${scrub((err as Error).message)}`;
        setState(db, "last_error", reason);
        notify(`⚠️ ${reason}`, { dedupeKey: "beeper-down", cooldownMs: COOLDOWN_BEEPER_MS, canWait: true });
        throw new Error(reason);
      }

      // 2. Read new messages (local, free).
      const ingest = await pollChats({ db, reader, dataDir, allChats: config.PLANS_ALL_CHATS, backfill: config.PLANS_BACKFILL, log });
      if (ingest.allowlistError) log(ingest.allowlistError);

      // 3. Detect plans in chats that have gone quiet (the only step that costs money).
      const llm = config.AI_GATEWAY_API_KEY ? createGatewayLlm({ apiKey: config.AI_GATEWAY_API_KEY, db, feature: "plans" }) : null;
      const detection = await runDetection({ db, detector: llm ? createHaikuDetector(llm) : null, log });

      // 4. Calendar events and pings (or, in dry run, a record of what would happen).
      const actions = await runActions(actionDeps(log));

      // 5. plans.md (and the archive).
      const files = writePlanFiles(db, dataDir);

      const errors = [...actions.errors, ...(detection.stoppedBecause ? [detection.stoppedBecause] : [])];
      setState(db, "last_run_error", errors[0] ?? null);
      if (ingest.newMessages || ingest.newReactions) log(`read ${ingest.newMessages} new messages, ${ingest.newReactions} reactions from ${ingest.chatsPolled} chats`);
      if (detection.batches || detection.failed) log(`detection: ${detection.batches} batches, ${detection.created} new plans, ${detection.updated} updated, ${detection.linked} linked, ${detection.rejected} rejected, ${detection.failed} failed`);
      if (actions.created || actions.updated || actions.removed || actions.pinged || actions.would) {
        log(`actions: ${actions.created} added, ${actions.updated} updated, ${actions.removed} removed, ${actions.pinged} pings, ${actions.would} would-do (dry run)`);
      }
      if (files.archived) log(`archived ${files.archived} old plan(s)`);
      if (actions.errors.length) throw new Error(actions.errors.slice(0, 3).join("; "));
    },
    { quiet: true },
  );
}
