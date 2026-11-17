import { NEVER_SWITCH } from "../fridge/lights";

// Home Assistant, as the voice tools see it: read the state of an allowlisted entity, and call a service on one. The
// allowlist comes from voice/entities.yaml; anything else is refused here, so no tool can reach beyond it by mistake.

export interface HaState {
  state: string;
  lastChanged: Date | null;
}
export interface VoiceHa {
  /** The states of several entities, one request. An entity Home Assistant does not know comes back as "unavailable". */
  read(entities: string[]): Promise<Record<string, HaState>>;
  /** Call a service on one entity, e.g. ("cover", "close_cover", "cover.garage_door"). */
  call(domain: string, service: string, entity: string): Promise<void>;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export function voiceHa(opts: { baseUrl: string; token: string; allowed: string[]; fetchFn?: FetchFn }): VoiceHa {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const fetchFn = opts.fetchFn ?? fetch;
  const allowed = new Set(opts.allowed);
  const headers = { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" };

  return {
    async read(entities) {
      for (const e of entities) if (!allowed.has(e)) throw new Error(`${e} is not allowed`);
      const res = await fetchFn(`${base}/api/states`, { headers, signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
      const all = (await res.json()) as { entity_id: string; state: string; last_changed?: string }[];
      const byId = new Map(all.map((s) => [s.entity_id, s]));
      const out: Record<string, HaState> = {};
      for (const e of entities) {
        const s = byId.get(e);
        out[e] = { state: s?.state ?? "unavailable", lastChanged: s?.last_changed ? new Date(s.last_changed) : null };
      }
      return out;
    },

    async call(domain, service, entity) {
      if (!allowed.has(entity)) throw new Error(`${entity} is not allowed`);
      if (NEVER_SWITCH.includes(entity)) throw new Error("that circuit must never be switched");
      const res = await fetchFn(`${base}/api/services/${domain}/${service}`, { method: "POST", headers, body: JSON.stringify({ entity_id: entity }), signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
    },
  };
}
