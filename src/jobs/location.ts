import { config } from "../config";
import { db } from "../db";
import { haClient } from "../fridge/ha";
import { openGarageOnArrival } from "../location/arrive";
import { createLocationWebhook } from "../location/webhook";
import { notify } from "../telegram";
import { registerWebhook } from "../webhooks";

const messages = { opened: "🏠 You're home: opening the garage.", failed: "🏠 You're home, but I couldn't open the garage.", unreadable: "🏠 You're home, but the garage door is unreadable so I left it." } as const;

export function registerLocation(): void {
  const ha = config.HA_TOKEN ? haClient(config.HA_URL, config.HA_TOKEN) : null;
  const onArriveHome = ha
    ? () => {
        void openGarageOnArrival(ha).then((result) => {
          console.log(`[location] arrived home: garage ${result}`);
          if (result === "opened" || result === "failed" || result === "unreadable") notify(messages[result]);
        });
      }
    : undefined;
  registerWebhook("location", createLocationWebhook({ db, onArriveHome }));
}
