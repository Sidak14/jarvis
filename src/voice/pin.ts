import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// The spoken PIN is never stored: only a scrypt hash of it (VOICE_PIN_HASH in .env, made by `npm run voice:set-pin`).
// It is checked here, in code, never by the model.

const N = 16384;
const KEY_LENGTH = 32;

/** Whatever was said or typed, reduced to the digits ("1 2 3 4" and "1234" are the same PIN). */
export const normalisePin = (text: string) => text.replace(/\D/g, "");

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(normalisePin(pin), salt, KEY_LENGTH, { N });
  return `scrypt:${N}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPin(pin: string, stored: string | undefined): boolean {
  const m = /^scrypt:(\d+):([0-9a-f]+):([0-9a-f]+)$/.exec(stored ?? "");
  if (!m) return false;
  const expected = Buffer.from(m[3], "hex");
  const actual = scryptSync(normalisePin(pin), Buffer.from(m[2], "hex"), expected.length, { N: Number(m[1]) });
  return timingSafeEqual(actual, expected);
}
