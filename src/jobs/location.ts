import { config } from "../config";
import { db } from "../db";
import { haClient } from "../fridge/ha";
import { closeGarageAfterLeaving, openGarageOnArrival } from "../location/arrive";
import { currentLocation, PEOPLE } from "../location/store";
import { createLocationWebhook } from "../location/webhook";
import { notify } from "../telegram";
import { settings } from "../settings";
import { registerWebhook } from "../webhooks";

// One webhook per person: POST /webhook/location/<me|mom|sukhleen>. What each person triggers (open on arrival, close after
// leaving, Telegram) is set on the Home Assistant page of the dashboard.
export function registerLocation(): void {
  const ha = config.HA_TOKEN ? haClient(config.HA_URL, config.HA_TOKEN) : null;
  for (const { key, name } of PEOPLE) {
    // What each person triggers, and whether Telegram hears about it, are settings (Home Assistant page): read when it happens.
    const tell = (text: string) => {
      if (settings.bool(`location.telegram.${key}`)) notify(text);
    };
    const onArriveHome = ha
      ? () => {
          if (!settings.bool(`location.open_on_arrive.${key}`)) return;
          void openGarageOnArrival(ha).then((result) => {
            console.log(`[location] ${key} arrived home: garage ${result}`);
            const who = key === "me" ? "You're" : `${name} is`;
            if (result === "opened") tell(`🏠 ${who} home: opening the garage.`);
            else if (result === "failed") tell(`🏠 ${who} home, but I couldn't open the garage.`);
            else if (result === "unreadable") tell(`🏠 ${who} home, but the garage door is unreadable so I left it.`);
          });
        }
      : undefined;
    const onLeaveHome = ha
      ? () => {
          if (!settings.bool(`location.close_on_leave.${key}`)) return;
          const stillAway = () => currentLocation(db, key)?.place !== "Home";
          void closeGarageAfterLeaving(ha, { stillAway }).then((result) => {
            console.log(`[location] ${key} left home: garage ${result}`);
            const who = key === "me" ? "You've" : `${name} has`;
            if (result === "closed") tell(`🏠 ${who} left and the garage had just been opened: closing it.`);
            else if (result === "failed" || result === "unreadable") tell(`🏠 ${who} left, but I couldn't check or close the garage.`);
          });
        }
      : undefined;
    registerWebhook(`location/${key}`, createLocationWebhook({ db, person: key, onArriveHome, onLeaveHome }));
  }
}
