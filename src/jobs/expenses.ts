import fs from "node:fs";
import { config } from "../config";
import { db } from "../db";
import { GoogleSheets } from "../expenses/sheets";
import { syncExpenses } from "../expenses/sync";
import { createExpenseWebhook } from "../expenses/webhook";
import { recordApiCall } from "../spotify/usage";
import { registerJob, triggerJob } from "../runner";
import { CATEGORISE_JOB } from "../telegram/settings";
import { registerWebhook } from "../webhooks";

export const SYNC_JOB = "expenses-sync";
const SYNC_CRON = "*/15 * * * *";

export function registerExpenses(): void {
  // null until GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_FILE are both set.
  const sheets =
    config.GOOGLE_SHEET_ID && config.GOOGLE_SERVICE_ACCOUNT_FILE
      ? new GoogleSheets({
          sheetId: config.GOOGLE_SHEET_ID,
          tab: config.GOOGLE_SHEET_TAB,
          keyFile: config.GOOGLE_SERVICE_ACCOUNT_FILE,
          onCall: () => recordApiCall(db, "google_sheets"),
        })
      : null;

  if (config.GOOGLE_SERVICE_ACCOUNT_FILE) {
    try {
      if (fs.statSync(config.GOOGLE_SERVICE_ACCOUNT_FILE).mode & 0o077) {
        console.warn("[expenses] the service account key file is readable by others: run chmod 600 on it");
      }
    } catch {
      console.warn("[expenses] GOOGLE_SERVICE_ACCOUNT_FILE does not exist yet");
    }
  }

  // Store first and answer 202; the Sheet is written afterwards, never while the Shortcut waits.
  registerWebhook(
    "expenses",
    createExpenseWebhook({
      db,
      onStored: () => {
        triggerJob(SYNC_JOB);
        triggerJob(CATEGORISE_JOB); // pick a category right away (or ask on Telegram)
      },
    }),
  );
  registerJob(SYNC_JOB, SYNC_CRON, ({ log }) => syncExpenses({ db, sheets, log }));
}
