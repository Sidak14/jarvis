import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ROOT } from "../config";
import { NEVER_SWITCH } from "../fridge/lights";

// voice/entities.yaml: the only Home Assistant things voice can touch. Loaded once; a bad file stops the voice tools, not Jarvis.

const entity = z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/, "must look like domain.name");

const schema = z.object({
  garage: z.object({ cover: entity, status: entity, sensor: entity, opener: entity }),
  lights: z.array(z.object({ name: z.string().min(2), entity, aliases: z.array(z.string()).default([]) })).min(1),
});
export type Entities = z.infer<typeof schema>;

/** "The Chandelier Lights!" and "chandelier" both become "chandelier". */
export const normaliseName = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\b(the|my|please|lights?|lamps?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function parseEntities(text: string): Entities {
  const data = schema.parse(parse(text));
  const lights = new Set(data.lights.map((l) => l.entity));
  if (lights.size !== data.lights.length) throw new Error("entities.yaml: a light is listed twice");
  for (const e of [data.garage.cover, ...lights]) {
    if (NEVER_SWITCH.includes(e)) throw new Error(`entities.yaml: ${e} trips the main circuit and must never be listed`);
  }
  // Names must be unambiguous: two lights cannot answer to the same words.
  const seen = new Map<string, string>();
  for (const l of data.lights) {
    for (const n of [l.name, ...l.aliases].map(normaliseName)) {
      if (seen.has(n) && seen.get(n) !== l.entity) throw new Error(`entities.yaml: "${n}" is used by two lights`);
      seen.set(n, l.entity);
    }
  }
  return data;
}

export function loadEntities(file = path.join(ROOT, "voice", "entities.yaml")): Entities {
  return parseEntities(fs.readFileSync(file, "utf8"));
}

/** The light a spoken name means, or null if none (or the words match nothing exactly). */
export function findLight(entities: Entities, spoken: string): Entities["lights"][number] | null {
  const want = normaliseName(spoken);
  if (!want) return null;
  return entities.lights.find((l) => [l.name, ...l.aliases].some((n) => normaliseName(n) === want)) ?? null;
}

/** Every entity voice may read or write, for the Home Assistant client's allowlist. */
export const allowedEntities = (e: Entities): string[] => [e.garage.cover, e.garage.status, e.garage.sensor, e.garage.opener, ...e.lights.map((l) => l.entity)];

// ---- the lights list as editable text, one light per line: "name | switch.entity | alias, alias"
export const lightsToText = (lights: Entities["lights"]): string => lights.map((l) => `${l.name} | ${l.entity}${l.aliases.length ? ` | ${l.aliases.join(", ")}` : ""}`).join("\n");

/** Parses the text above and applies every safety rule (never the main-circuit light, no duplicates, unambiguous names). Throws a plain message. */
export function parseLightLines(text: string): Entities["lights"] {
  const lights = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [name, ent, aliases] = line.split("|").map((x) => x.trim());
      if (!name || !ent) throw new Error(`"${line.slice(0, 40)}": write it as  name | switch.entity | alias, alias`);
      return { name, entity: ent, aliases: (aliases ?? "").split(",").map((a) => a.trim()).filter(Boolean) };
    });
  if (!lights.length) throw new Error("list at least one light");
  const check = z.array(z.object({ name: z.string().min(2), entity, aliases: z.array(z.string()) })).safeParse(lights);
  if (!check.success) throw new Error(check.error.issues[0].message.replace("must look like domain.name", "the entity must look like switch.name"));
  return parseEntities(`garage: { cover: a.b, status: a.b, sensor: a.b, opener: a.b }\nlights: ${JSON.stringify(lights)}`).lights;
}
