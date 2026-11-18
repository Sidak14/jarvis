import type Database from "better-sqlite3";
import type { Def } from "./defs";
import { DEFS } from "./defs";

// Settings I can change on the dashboard without a restart. Every setting has a default in code (defs.ts); a value I save
// is kept in the app_settings table and wins. Code reads a setting where it is used, so a change takes effect within seconds.
// Before bind() is called (and in tests) every setting just returns its default.

export type SettingKey = string;
type Value = number | string | boolean;

const CACHE_MS = 2000;

export type Parsed = { ok: true; value: Value } | { ok: false; error: string };

/** Turn what was typed into a value of the setting's type, or say what is wrong with it. */
export function parseSetting(def: Def, raw: string): Parsed {
  const text = raw.trim();
  switch (def.type) {
    case "number": {
      if (text === "" || !Number.isFinite(Number(text))) return { ok: false, error: "must be a number" };
      const n = Number(text);
      if (def.int && !Number.isInteger(n)) return { ok: false, error: "must be a whole number" };
      if (n < def.min || n > def.max) return { ok: false, error: `must be between ${def.min} and ${def.max}` };
      return { ok: true, value: n };
    }
    case "bool":
      if (/^(1|true|on|yes)$/i.test(text)) return { ok: true, value: true };
      if (/^(0|false|off|no|)$/i.test(text)) return { ok: true, value: false };
      return { ok: false, error: "must be on or off" };
    case "choice":
      return def.choices.includes(text) ? { ok: true, value: text } : { ok: false, error: `must be one of: ${def.choices.join(", ")}` };
    case "lines": {
      const value = raw.replace(/\r/g, "").trim();
      if (value.length > (def.maxLength ?? 4000)) return { ok: false, error: "too long" };
      const problem = def.check?.(value) ?? null;
      return problem ? { ok: false, error: problem } : { ok: true, value };
    }
  }
}

const defaultOf = (def: Def): Value => (typeof def.default === "function" ? (def.default as () => Value)() : def.default);

export class Settings {
  private db: Database.Database | null = null;
  private cache: { at: number; rows: Map<string, string> } | null = null;
  private listeners: ((key: string) => void)[] = [];

  bind(db: Database.Database): void {
    this.db = db;
    this.cache = null;
  }

  /** Back to defaults only (for tests). */
  unbind(): void {
    this.db = null;
    this.cache = null;
  }

  private rows(): Map<string, string> {
    if (!this.db) return new Map();
    if (!this.cache || Date.now() - this.cache.at > CACHE_MS) {
      const rows = new Map((this.db.prepare(`SELECT key, value FROM app_settings`).all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
      this.cache = { at: Date.now(), rows };
    }
    return this.cache.rows;
  }

  /** The saved raw text for any key (also used for the job schedules, which are not in defs.ts), or null. */
  raw(key: string): string | null {
    return this.rows().get(key) ?? null;
  }

  private def(key: string): Def {
    const def = DEFS[key];
    if (!def) throw new Error(`unknown setting: ${key}`);
    return def;
  }

  get(key: SettingKey): Value {
    const def = this.def(key);
    const saved = this.raw(key);
    if (saved !== null) {
      const parsed = parseSetting(def, saved);
      if (parsed.ok) return parsed.value;
    }
    return defaultOf(def);
  }
  num = (key: SettingKey) => this.get(key) as number;
  bool = (key: SettingKey) => this.get(key) as boolean;
  str = (key: SettingKey) => this.get(key) as string;

  isCustom(key: SettingKey): boolean {
    return this.raw(key) !== null;
  }
  defaultFor(key: SettingKey): Value {
    return defaultOf(this.def(key));
  }

  /** Save what was typed. Returns an error message, or null when it was saved. */
  set(key: SettingKey, raw: string): string | null {
    const parsed = parseSetting(this.def(key), raw);
    if (!parsed.ok) return parsed.error;
    this.write(key, typeof parsed.value === "boolean" ? (parsed.value ? "1" : "0") : String(parsed.value));
    return null;
  }

  write(key: string, value: string): void {
    if (!this.db) throw new Error("settings are not set up");
    this.db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, new Date().toISOString());
    this.cache = null;
    for (const fn of this.listeners) fn(key);
  }

  reset(key: string): void {
    if (!this.db) return;
    this.db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(key);
    this.cache = null;
    for (const fn of this.listeners) fn(key);
  }

  /** Called after a setting is saved or reset (the job schedules use it to reschedule at once). */
  onChange(fn: (key: string) => void): void {
    this.listeners.push(fn);
  }
}
