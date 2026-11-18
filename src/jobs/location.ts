import { config } from "../config";
import { db } from "../db";
import { haClient } from "../fridge/ha";
import { openGarageOnArrival } from "../location/arrive";
import { PEOPLE } from "../location/store";
import { createLocationWebhook } from "../location/webhook";
import { notify } from "../telegram";
import { registerWebhook } from "../webhooks";

// One webhook per person: POST /webhook/location/me and /webhook/location/mom. When either gets home the garage opens.
export function registerLocation(): void {
  const ha = config.HA_TOKEN ? haClient(config.HA_URL, config.HA_TOKEN) : null;
  for (const { key, name } of PEOPLE) {
    const onArriveHome = ha
      ? () => {
          void openGarageOnArrival(ha).then((result) => {
            console.log(`[location] ${key} arrived home: garage ${result}`);
            const who = key === "me" ? "You're" : `${name} is`;
            if (result === "opened") notify(`🏠 ${who} home: opening the garage.`);
            else if (result === "failed") notify(`🏠 ${who} home, but I couldn't open the garage.`);
            else if (result === "unreadable") notify(`🏠 ${who} home, but the garage door is unreadable so I left it.`);
          });
        }
      : undefined;
    registerWebhook(`location/${key}`, createLocationWebhook({ db, person: key, onArriveHome }));
  }
}
