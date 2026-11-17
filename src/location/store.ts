import type Database from "better-sqlite3";

// Where I am, from the phone's "enter" / "leave" automations (Shortcuts). The places the phone knows
// are home, work and gym; anywhere else is "Other".

export const PLACES = ["home", "work", "gym"] as const;
export const EVENTS = ["enter", "leave"] as const;
export type KnownPlace = (typeof PLACES)[number];
export type LocationEvent = (typeof EVENTS)[number];
export type Where = "Home" | "Work" | "Gym" | "Other";

const label = (p: KnownPlace): Where => (p === "home" ? "Home" : p === "work" ? "Work" : "Gym");

/** Reads {"kind": "location", "place": "home|work|gym", "event": "enter|leave"}. null if it is anything else. */
export function parseLocation(body: unknown): { place: KnownPlace; event: LocationEvent } | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.kind !== undefined && String(b.kind).trim().toLowerCase() !== "location") return null;
  const place = String(b.place ?? "").trim().toLowerCase();
  const event = String(b.event ?? "").trim().toLowerCase();
  if (!(PLACES as readonly string[]).includes(place) || !(EVENTS as readonly string[]).includes(event)) return null;
  return { place: place as KnownPlace, event: event as LocationEvent };
}

export function currentLocation(db: Database.Database): { place: Where; since: string } | null {
  return (db.prepare(`SELECT place, since FROM location_now WHERE id = 1`).get() as { place: Where; since: string } | undefined) ?? null;
}

/**
 * Enter X: I am at X. Leave X: I am "Other", but only if I was at X (a late "leave work" that arrives after
 * "enter gym" must not undo the gym). Every report is logged.
 */
export function applyLocation(db: Database.Database, report: { place: KnownPlace; event: LocationEvent }, now: Date): Where {
  const at = now.toISOString();
  db.prepare(`INSERT INTO location_events (place, event, received_at) VALUES (?, ?, ?)`).run(report.place, report.event, at);
  const current = currentLocation(db);
  const next: Where = report.event === "enter" ? label(report.place) : current?.place === label(report.place) ? "Other" : (current?.place ?? "Other");
  if (current?.place !== next || !current) {
    db.prepare(`INSERT INTO location_now (id, place, since) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET place = excluded.place, since = excluded.since`).run(next, at);
  }
  return next;
}
