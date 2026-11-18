import { config } from "../config";
import { db } from "../db";
import { haClient } from "../fridge/ha";
import { closeGarageAfterLeaving, openGarageOnArrival } from "../location/arrive";
import { currentLocation, PEOPLE } from "../location/store";
import { createLocationWebhook } from "../location/webhook";
import { notify } from "../telegram";
import { registerWebhook } from "../webhooks";

// One webhook per person: POST /webhook/location/<me|mom|sukhleen>. When I get home the garage opens;
// a minute after anyone leaves, a garage that was opened in the last 3 minutes is closed.
export function registerLocation(): void {
  const ha = config.HA_TOKEN ? haClient(config.HA_URL, config.HA_TOKEN) : null;
  for (const { key } of PEOPLE) {
    // The garage acts for everyone, but Telegram only tells me about my own comings and goings.
    const tell = (text: string) => {
      if (key === "me") notify(text);
    };
    // Only my arriving home opens the garage; everyone's leaving can close it.
    const onArriveHome = ha && key === "me"
      ? () => {
          void openGarageOnArrival(ha).then((result) => {
            console.log(`[location] ${key} arrived home: garage ${result}`);
            if (result === "opened") tell("🏠 You're home: opening the garage.");
            else if (result === "failed") tell("🏠 You're home, but I couldn't open the garage.");
            else if (result === "unreadable") tell("🏠 You're home, but the garage door is unreadable so I left it.");
          });
        }
      : undefined;
    const onLeaveHome = ha
      ? () => {
          const stillAway = () => currentLocation(db, key)?.place !== "Home";
          void closeGarageAfterLeaving(ha, { stillAway }).then((result) => {
            console.log(`[location] ${key} left home: garage ${result}`);
            if (result === "closed") tell("🏠 You've left and the garage had just been opened: closing it.");
            else if (result === "failed" || result === "unreadable") tell("🏠 You've left, but I couldn't check or close the garage.");
          });
        }
      : undefined;
    registerWebhook(`location/${key}`, createLocationWebhook({ db, person: key, onArriveHome, onLeaveHome }));
  }
}
