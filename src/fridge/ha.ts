import { GARAGE_COVER, GARAGE_OPENER, GARAGE_STATUS, garageState, type Garage, type GarageAction } from "./garage";
import { NEVER_SWITCH } from "./lights";

// A tiny Home Assistant client for the fridge page: read some switch states, turn one on or off. The token stays on
// the server; the browser never sees it.

export type LightState = "on" | "off" | "unavailable";

export interface HaClient {
  /** The state of each entity. Anything missing or odd (unavailable, unknown) comes back as "unavailable". */
  states(entities: string[]): Promise<Record<string, LightState>>;
  setSwitch(entity: string, on: boolean): Promise<void>;
  garage(): Promise<Garage>;
  /** Press Open or Close. Home Assistant ignores it if the door is not in the right state or is already moving. */
  pressGarage(action: GarageAction): Promise<void>;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export function haClient(baseUrl: string, token: string, fetchFn: FetchFn = fetch): HaClient {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  return {
    async states(entities) {
      const res = await fetchFn(`${base}/api/states`, { headers, signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
      const all = (await res.json()) as { entity_id: string; state: string }[];
      const byId = new Map(all.map((s) => [s.entity_id, s.state]));
      const out: Record<string, LightState> = {};
      for (const e of entities) {
        const s = byId.get(e);
        out[e] = s === "on" || s === "off" ? s : "unavailable";
      }
      return out;
    },

    async setSwitch(entity, on) {
      if (NEVER_SWITCH.includes(entity)) throw new Error("this switch must never be turned on or off from here");
      const res = await fetchFn(`${base}/api/services/switch/${on ? "turn_on" : "turn_off"}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ entity_id: entity }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
    },

    async garage() {
      const read = async (entity: string) => {
        const res = await fetchFn(`${base}/api/states/${entity}`, { headers, signal: AbortSignal.timeout(4000) });
        if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
        return ((await res.json()) as { state?: string }).state;
      };
      const [status, opener] = await Promise.all([read(GARAGE_STATUS), read(GARAGE_OPENER)]);
      return { state: garageState(status), opener: opener === "on" };
    },

    async pressGarage(action) {
      const res = await fetchFn(`${base}/api/services/cover/${action === "open" ? "open_cover" : "close_cover"}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ entity_id: GARAGE_COVER }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
    },
  };
}
