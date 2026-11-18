import { GARAGE_COVER, GARAGE_OPENER, GARAGE_SENSOR, GARAGE_STATUS, garageState, type Garage, type GarageAction } from "./garage";
import { NEVER_SWITCH } from "./lights";
import { TV_KEYS, TV_PLAYER, TV_REMOTE, type Tv, type TvKey } from "./tv";

// A tiny Home Assistant client for the fridge page: read some switch states, turn one on or off. The token stays on
// the server; the browser never sees it.

export type LightState = "on" | "off" | "unavailable";

export interface HaClient {
  /** The state of each entity. Anything missing or odd (unavailable, unknown) comes back as "unavailable". */
  states(entities: string[]): Promise<Record<string, LightState>>;
  setSwitch(entity: string, on: boolean): Promise<void>;
  garage(): Promise<Garage>;
  /** How long the door has been in its current state (open or closed), from the tilt sensor; null if unknown. */
  garageStateAgeMs(): Promise<number | null>;
  /** Press Open or Close. Home Assistant ignores it if the door is not in the right state or is already moving. */
  pressGarage(action: GarageAction): Promise<void>;
  tv(): Promise<Tv>;
  /** Send one remote key. Power turns the TV on through Home Assistant when it is off (the remote only works while it is on). */
  tvKey(key: TvKey): Promise<void>;
  /** Switch input. Only a source the TV itself lists is sent. Returns false if it is not one. */
  tvSource(source: string): Promise<boolean>;
  /** A still picture from a camera (a JPEG). */
  snapshot(entity: string): Promise<{ type: string; body: ArrayBuffer }>;
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

    async garageStateAgeMs() {
      const res = await fetchFn(`${base}/api/states/${GARAGE_SENSOR}`, { headers, signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
      const changed = Date.parse(((await res.json()) as { last_changed?: string }).last_changed ?? "");
      return Number.isFinite(changed) ? Math.max(0, Date.now() - changed) : null;
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

    async tv() {
      const res = await fetchFn(`${base}/api/states/${TV_PLAYER}`, { headers, signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
      const s = (await res.json()) as { state?: string; attributes?: { volume_level?: number; is_volume_muted?: boolean; source?: string; source_list?: string[] } };
      const a = s.attributes ?? {};
      return {
        state: s.state === "on" || s.state === "off" ? s.state : "unavailable",
        muted: a.is_volume_muted === true,
        volume: typeof a.volume_level === "number" ? Math.round(a.volume_level * 100) : null,
        sources: Array.isArray(a.source_list) ? a.source_list.filter((x) => typeof x === "string") : [],
        source: typeof a.source === "string" ? a.source : null,
      };
    },

    async tvKey(key) {
      const on = key === "power" && (await this.tv()).state !== "on";
      const [path, body] = on
        ? ["media_player/turn_on", { entity_id: TV_PLAYER }]
        : ["remote/send_command", { entity_id: TV_REMOTE, command: TV_KEYS[key] }];
      const res = await fetchFn(`${base}/api/services/${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
    },

    async tvSource(source) {
      if (!(await this.tv()).sources.includes(source)) return false;
      const res = await fetchFn(`${base}/api/services/media_player/select_source`, {
        method: "POST",
        headers,
        body: JSON.stringify({ entity_id: TV_PLAYER, source }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
      return true;
    },

    async snapshot(entity) {
      const res = await fetchFn(`${base}/api/camera_proxy/${entity}`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
      return { type: res.headers.get("content-type") ?? "image/jpeg", body: await res.arrayBuffer() };
    },
  };
}
