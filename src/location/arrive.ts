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

export type LeaveResult = "closed" | "not open" | "opened a while ago" | "back home" | "unreadable" | "failed";

const WAIT_AFTER_LEAVING_MS = 60_000;
/** A door opened more recently than this, as I leave, was left open by mistake. One opened earlier was meant to stay open. */
const LEFT_OPEN_WITHIN_MS = 3 * 60_000;

/**
 * Someone left home: wait a minute, then if the garage is open and was opened in the last 3 minutes, close it.
 * (A door that has been open longer than that was opened on purpose.) Does nothing if they are back home by then.
 */
export async function closeGarageAfterLeaving(
  ha: HaClient,
  opts: { stillAway: () => boolean; sleep?: (ms: number) => Promise<void>; waitMs?: number; withinMs?: number },
): Promise<LeaveResult> {
  await (opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(opts.waitMs ?? WAIT_AFTER_LEAVING_MS);
  try {
    if (!opts.stillAway()) return "back home";
    const garage = await ha.garage();
    if (garage.state === "unavailable" || !garage.opener) return "unreadable";
    if (garage.state !== "open") return "not open";
    const openFor = await ha.garageStateAgeMs();
    if (openFor === null) return "unreadable";
    if (openFor > (opts.withinMs ?? LEFT_OPEN_WITHIN_MS)) return "opened a while ago";
    await ha.pressGarage("close");
    return "closed";
  } catch {
    return "failed";
  }
}
