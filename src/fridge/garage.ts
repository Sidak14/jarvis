// The garage door as the home screen sees it. Home Assistant does the work (see homeassistant/config/packages/garage.yaml):
// the status comes from the tilt sensor, and it only lets Open through when the door is closed and Close when it is open.

export const GARAGE_STATUS = "sensor.garage_door_status";
export const GARAGE_COVER = "cover.garage_door";

export type GarageState = "open" | "closed" | "opening" | "closing" | "unavailable";
export type GarageAction = "open" | "close";

export const garageState = (raw: string | undefined): GarageState =>
  raw === "open" || raw === "closed" || raw === "opening" || raw === "closing" ? raw : "unavailable";
