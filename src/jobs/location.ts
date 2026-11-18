import { config } from "../config";
import { db } from "../db";
import { haClient } from "../fridge/ha";
import { closeGarageAfterLeaving, openGarageOnArrival } from "../location/arrive";
import { currentLocation, PEOPLE } from "../location/store";
import { createLocationWebhook } from "../location/webhook";
import { notify } from "../telegram";
import { registerWebhook } from "../webhooks";

// One webhook per person: POST /webhook/location/me and /webhook/location/mom. When either gets home the garage opens;
// a minute after either leaves, a garage that was opened in the last 3 minutes is closed.
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
    const onLeaveHome = ha
      ? () => {
          const stillAway = () => currentLocation(db, key)?.place !== "Home";
          void closeGarageAfterLeaving(ha, { stillAway }).then((result) => {
            console.log(`[location] ${key} left home: garage ${result}`);
            const who = key === "me" ? "You've" : `${name} has`;
            if (result === "closed") notify(`🏠 ${who} left and the garage had just been opened: closing it.`);
            else if (result === "failed" || result === "unreadable") notify(`🏠 ${who} left, but I couldn't check or close the garage.`);
          });
        }
      : undefined;
    registerWebhook(`location/${key}`, createLocationWebhook({ db, person: key, onArriveHome, onLeaveHome }));
  }
}
