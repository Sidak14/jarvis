import { config } from "../config";
import { db } from "../db";
import { registerJob } from "../runner";
import { notify } from "../telegram";
import { runAlerts, handleCallEnded, type AlertDeps } from "../voice/alerts";
import { createHaWebhook } from "../voice/ha-webhook";
import { setCallEndedHandler, savedAssistantId } from "../voice/routes";
import { readGarage } from "../voice/tools/garage";
import { entities, toolDeps } from "../voice/wiring";
import { vapiCalls } from "../voice/vapi-api";

// The voice watchdog: every 5 minutes look at the garage (in case Home Assistant's webhook was missed) and retry the phone
// call when the rules allow. Quiet when there is nothing to do.

export const VOICE_JOB = "voice-alerts";
const VOICE_CRON = "*/5 * * * *";

function alertDeps(): AlertDeps {
  const placer =
    config.VAPI_API_KEY && config.VAPI_PHONE_NUMBER_ID
      ? vapiCalls({ apiKey: config.VAPI_API_KEY, phoneNumberId: config.VAPI_PHONE_NUMBER_ID, assistantId: savedAssistantId })
      : null;
  return {
    db,
    now: () => new Date(),
    enabled: config.VOICE_ENABLED && Boolean(config.OWNER_PHONE),
    ownerPhone: config.OWNER_PHONE,
    capUsd: config.VOICE_MONTHLY_CAP_USD,
    garage: () => readGarage(toolDeps, new Date()),
    placeCall: async ({ alert }) => {
      if (!placer || !config.OWNER_PHONE) throw new Error("Vapi is not set up");
      return placer.placeAlertCall({ number: config.OWNER_PHONE, alert });
    },
    notify,
    log: (m) => console.log(`[voice] ${m}`),
  };
}

export const checkAlerts = () => runAlerts(alertDeps());

export function registerVoice(): void {
  setCallEndedHandler((call) => handleCallEnded({ db, notify, now: () => new Date() }, call));
  registerJob(
    VOICE_JOB,
    VOICE_CRON,
    async ({ log }) => {
      const did = await checkAlerts();
      if (did.length) log(did.join("; "));
    },
    { quiet: true },
  );
  void entities; // the allowlist is loaded (and validated) at startup
}

/** The Home Assistant webhook (mounted in app.ts). */
export const haWebhookRoutes = createHaWebhook({ secret: config.WEBHOOK_SECRET, onGarageOpen: checkAlerts, log: (m) => console.log(`[voice] ${m}`) });
