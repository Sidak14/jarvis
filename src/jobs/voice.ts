import { config } from "../config";
import { settings } from "../settings";
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
      ? vapiCalls({ apiKey: config.VAPI_API_KEY, phoneNumberId: config.VAPI_PHONE_NUMBER_ID, assistantId: savedAssistantId, maxSeconds: settings.num("voice.alert_call_max_seconds") })
      : null;
  return {
    db,
    now: () => new Date(),
    enabled: config.VOICE_ENABLED && Boolean(config.OWNER_PHONE),
    ownerPhone: config.OWNER_PHONE,
    capUsd: () => settings.num("voice.monthly_cap_usd"),
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
let garageTimer: NodeJS.Timeout | undefined;
/**
 * Home Assistant tells Jarvis the moment the door opens. Jarvis keeps the time itself, so changing "phone me after" on the
 * dashboard needs no change in Home Assistant: look now, and again once the door has been open that long.
 */
export async function onGarageOpened(): Promise<void> {
  clearTimeout(garageTimer);
  garageTimer = setTimeout(() => void checkAlerts().catch((err) => console.error(`[voice] garage timer check failed: ${(err as Error).message}`)), (settings.num("voice.garage_open_seconds") + 3) * 1000);
  garageTimer.unref();
  await checkAlerts();
}

export const haWebhookRoutes = createHaWebhook({ secret: config.WEBHOOK_SECRET, onGarageOpen: onGarageOpened, log: (m) => console.log(`[voice] ${m}`) });
