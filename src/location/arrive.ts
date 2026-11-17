import type { HaClient } from "../fridge/ha";

// Arriving home opens the garage, but only if it is closed and the opener is reachable. Open, moving or unreadable: do nothing.

export type ArriveResult = "opened" | "already open" | "moving" | "unreadable" | "failed";

export async function openGarageOnArrival(ha: HaClient): Promise<ArriveResult> {
  try {
    const garage = await ha.garage();
    if (garage.state === "unavailable" || !garage.opener) return "unreadable";
    if (garage.state === "open") return "already open";
    if (garage.state !== "closed") return "moving";
    await ha.pressGarage("open");
    return "opened";
  } catch {
    return "failed";
  }
}
