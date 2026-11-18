import type Database from "better-sqlite3";
import { lookupAddress, type Lookup } from "./geocode";

// Saved private places ("Home", "Rijul's house"). The model only ever sees the NAMES. When a plan
// uses a name that is not saved yet, Jarvis asks you for the address on Telegram; the address is
// used on the calendar event. Public venues (restaurants...) are not saved: the model gives their address.

export interface Place {
  id: number;
  name: string;
  /** Google's full address once it has been looked up; until then what I typed. */
  address: string | null;
  /** What I typed, kept when Google's address replaced it. */
  typed_address: string | null;
  /** Google's id for the place (makes the map link exact). */
  place_id: string | null;
  /** 1 once Google found this address. */
  verified: number;
  asked_message_id: number | null;
  asked_at: string | null;
  created_at: string;
}

const MAX_ADDRESS_CHARS = 200;
const clip = (text: string, max: number) => text.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max);

export function listPlaces(db: Database.Database): Place[] {
  return db.prepare(`SELECT * FROM places ORDER BY name COLLATE NOCASE`).all() as Place[];
}

export function findPlace(db: Database.Database, name: string | null): Place | undefined {
  if (!name) return undefined;
  return db.prepare(`SELECT * FROM places WHERE name = ? COLLATE NOCASE`).get(name.trim()) as Place | undefined;
}

/** The saved place with this name, made (without an address yet) if it is new. */
export function ensurePlace(db: Database.Database, name: string, now: Date): Place {
  const clean = clip(name, 60);
  const existing = findPlace(db, clean);
  if (existing) return existing;
  db.prepare(`INSERT INTO places (name, created_at) VALUES (?, ?)`).run(clean, now.toISOString());
  return findPlace(db, clean)!;
}

/** "7 John Campbell parade, bungarribee" has no state or country, so Google may not find it: add them when they are missing. */
export function withRegion(address: string): string {
  return /\b(australia|nsw|new south wales|vic|qld|act|tas|wa|sa|nt)\b/i.test(address) ? address : `${address}, NSW, Australia`;
}

/** What goes in the calendar event's location: a saved place's address (with its state), else the text as it is. */
export function resolveLocation(db: Database.Database, location: string | null): string | null {
  const place = findPlace(db, location);
  return place ? (place.address ? (place.verified ? place.address : withRegion(place.address)) : place.name) : location;
}

/** A Google Maps link for a plan's location. None for a saved place with no address yet (the name alone would find the wrong place). */
export function mapsUrl(db: Database.Database, location: string | null): string | null {
  if (!location) return null;
  const place = findPlace(db, location);
  if (place && !place.address) return null;
  const exact = place?.place_id ? `&query_place_id=${encodeURIComponent(place.place_id)}` : "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(resolveLocation(db, location)!)}${exact}`;
}

/** Places that still need an address and have not been asked about yet. */
export function placesToAsk(db: Database.Database): Place[] {
  return db.prepare(`SELECT * FROM places WHERE address IS NULL AND asked_at IS NULL ORDER BY id`).all() as Place[];
}
export function markAsked(db: Database.Database, id: number, now: Date): void {
  db.prepare(`UPDATE places SET asked_at = ? WHERE id = ?`).run(now.toISOString(), id);
}
/** Telegram accepted the question: remember which message asked about which place. */
export function attachPlaceMessage(db: Database.Database, id: number, messageId: number): void {
  db.prepare(`UPDATE places SET asked_message_id = ? WHERE id = ?`).run(messageId, id);
}
export function placeByQuestionMessage(db: Database.Database, messageId: number): Place | undefined {
  return db.prepare(`SELECT * FROM places WHERE asked_message_id = ?`).get(messageId) as Place | undefined;
}

/** Your reply to "where is X?". The text is stored as data and never interpreted. Returns the saved place, or null if empty. */
export function saveAddress(db: Database.Database, id: number, text: string): Place | null {
  const address = clip(text, MAX_ADDRESS_CHARS);
  if (!address) return null;
  db.prepare(`UPDATE places SET address = ?, typed_address = ?, place_id = NULL, verified = 0 WHERE id = ?`).run(address, address, id);
  return getPlace(db, id)!;
}

export const getPlace = (db: Database.Database, id: number) => db.prepare(`SELECT * FROM places WHERE id = ?`).get(id) as Place | undefined;

/**
 * Ask Google for the real address of what I typed. Found: the place now shows Google's full address (and keeps what I typed).
 * Not found / not set up / error: the typed address stays, marked "not verified", and the reason is returned to show.
 */
export async function verifyPlace(db: Database.Database, id: number, apiKey: string | undefined, fetchFn?: Parameters<typeof lookupAddress>[1]["fetchFn"]): Promise<Lookup> {
  const place = getPlace(db, id);
  const typed = place?.typed_address ?? place?.address;
  if (!place || !typed) return { ok: false, reason: "not_found", message: "This place has no address to look up." };
  const found = await lookupAddress(typed, { apiKey, fetchFn });
  if (found.ok) db.prepare(`UPDATE places SET address = ?, typed_address = ?, place_id = ?, verified = 1 WHERE id = ?`).run(found.address, typed, found.placeId, id);
  return found;
}

/** Edit from the dashboard: a new name and/or a new address (the address is then looked up again by the caller). Returns an error message or null. */
export function editPlace(db: Database.Database, id: number, name: string, address: string): string | null {
  const place = getPlace(db, id);
  if (!place) return "that place no longer exists";
  const newName = clip(name, 60);
  if (!newName) return "the name can't be empty";
  const clash = findPlace(db, newName);
  if (clash && clash.id !== id) return `there is already a place called ${clash.name}`;
  const newAddress = clip(address, MAX_ADDRESS_CHARS);
  db.transaction(() => {
    if (newName !== place.name) {
      db.prepare(`UPDATE places SET name = ? WHERE id = ?`).run(newName, id);
      // Plans that used the old name follow the rename.
      db.prepare(`UPDATE plans SET location = ? WHERE location = ? COLLATE NOCASE`).run(newName, place.name);
    }
    // The address field shows Google's version; only a changed text is a new address.
    if (newAddress !== (place.address ?? "") && newAddress !== (place.typed_address ?? "")) {
      db.prepare(`UPDATE places SET address = ?, typed_address = ?, place_id = NULL, verified = 0 WHERE id = ?`).run(newAddress || null, newAddress || null, id);
    }
  })();
  return null;
}

/** Remove a saved place. Plans that were at it keep their text; if it is mentioned again Jarvis will ask about it again. */
export function deletePlace(db: Database.Database, id: number): boolean {
  return db.prepare(`DELETE FROM places WHERE id = ?`).run(id).changes > 0;
}

export function questionText(p: Place): string {
  return `What is the address of "${p.name}"? Reply to this message with it and I'll remember it for your calendar events.`;
}

export function placesText(db: Database.Database): string {
  const all = listPlaces(db);
  if (all.length === 0) return "No saved places yet. I'll ask when a plan is somewhere new.";
  return ["Saved places:", ...all.map((p) => `${p.name}: ${p.address ?? "(address not given yet)"}`)].join("\n");
}
