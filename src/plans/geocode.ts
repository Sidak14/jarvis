// Finds the real address of a place I typed ("16 Horsfield Street") with Google's Geocoding API. Needs GOOGLE_MAPS_API_KEY.
// Only the typed text is sent to Google, never a plan, chat or name.

export type Lookup =
  | { ok: true; address: string; placeId: string }
  | { ok: false; reason: "not_configured" | "not_found" | "error"; message: string };

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// Prefer Sydney when the text could be anywhere (a bias, not a limit: other Australian places are still found).
const SYDNEY_BOUNDS = "-34.2,150.6|-33.5,151.4";

export async function lookupAddress(text: string, opts: { apiKey: string | undefined; fetchFn?: FetchFn }): Promise<Lookup> {
  if (!opts.apiKey) return { ok: false, reason: "not_configured", message: "Google Maps isn't configured yet (GOOGLE_MAPS_API_KEY is missing), so I can't look the address up." };
  const query = text.trim();
  if (!query) return { ok: false, reason: "not_found", message: "There was no address to look up." };
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&components=country:AU&bounds=${encodeURIComponent(SYDNEY_BOUNDS)}&key=${encodeURIComponent(opts.apiKey)}`;
  try {
    const res = await (opts.fetchFn ?? fetch)(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, reason: "error", message: `Google Maps answered ${res.status}.` };
    const data = (await res.json()) as { status?: string; error_message?: string; results?: { formatted_address?: string; place_id?: string }[] };
    if (data.status === "ZERO_RESULTS") return { ok: false, reason: "not_found", message: `Google couldn't find "${query.slice(0, 80)}".` };
    if (data.status !== "OK") return { ok: false, reason: "error", message: `Google Maps said ${data.status ?? "something odd"}${data.error_message ? `: ${data.error_message.slice(0, 120)}` : ""}.` };
    const best = data.results?.[0];
    if (!best?.formatted_address || !best.place_id) return { ok: false, reason: "not_found", message: `Google couldn't find "${query.slice(0, 80)}".` };
    return { ok: true, address: best.formatted_address, placeId: best.place_id };
  } catch (err) {
    return { ok: false, reason: "error", message: `Couldn't reach Google Maps: ${(err as Error).message}` };
  }
}
