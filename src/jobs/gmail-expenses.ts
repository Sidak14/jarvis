import { createGatewayLlm } from "../ai/llm";
import { config } from "../config";
import { db } from "../db";
import { SYNC_JOB } from "./expenses";
import { createGmailClient } from "../gmail/client";
import { gmailAuth } from "../gmail";
import { runGmailExpenses } from "../gmail/job";
import { JOB_NAME, POLL_CRON } from "../gmail/settings";
import { registerJob, triggerJob } from "../runner";
import { CATEGORISE_JOB } from "../telegram/settings";

export function registerGmailExpenses(): void {
  registerJob(JOB_NAME, POLL_CRON, async ({ log }) => {
    // Missing setup fails the run loudly (red on the status page) instead of doing nothing.
    if (!gmailAuth.isConfigured()) {
      throw new Error("Gmail is not configured: set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env, then restart");
    }
    if (!config.AI_GATEWAY_API_KEY) {
      throw new Error("AI is not configured: set AI_GATEWAY_API_KEY in .env, then restart");
    }
    await runGmailExpenses({
      db,
      gmail: createGmailClient(gmailAuth, db),
      llm: createGatewayLlm({ apiKey: config.AI_GATEWAY_API_KEY, db, feature: "invoices" }),
      dryRun: config.GMAIL_DRY_RUN,
      log,
      onChanged: () => {
        triggerJob(SYNC_JOB);
        triggerJob(CATEGORISE_JOB);
      },
    });
  });
}
