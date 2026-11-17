import { z } from "zod";
import { defineTool } from "../registry";
import { spokenDuration } from "../speak";
import { wait, type ToolDeps } from "./deps";

// The garage door as the voice assistant sees it: the status comes from the tilt sensor (Home Assistant's
// sensor.garage_door_status), and "for how long" from when the tilt sensor last changed.

export type GarageState = "open" | "closed" | "opening" | "closing" | "unavailable";
export interface GarageReading {
  state: GarageState;
  /** How long the door has been open or closed (null while it is moving or unknown). */
  sinceMs: number | null;
  /** Is the opener box on Wi-Fi? */
  opener: boolean;
}

export async function readGarage(deps: ToolDeps, now: Date): Promise<GarageReading> {
  if (!deps.ha) return { state: "unavailable", sinceMs: null, opener: false };
  const g = deps.entities.garage;
  const s = await deps.ha.read([g.status, g.sensor, g.opener]);
  const raw = s[g.status].state;
  const state: GarageState = raw === "open" || raw === "closed" || raw === "opening" || raw === "closing" ? raw : "unavailable";
  const changed = s[g.sensor].lastChanged;
  return {
    state,
    sinceMs: (state === "open" || state === "closed") && changed ? Math.max(0, now.getTime() - changed.getTime()) : null,
    opener: s[g.opener].state === "on",
  };
}

/** One spoken sentence about the garage. */
export function garageSentence(r: GarageReading): string {
  if (r.state === "unavailable") return "I can't read the garage door right now.";
  if (r.state === "opening" || r.state === "closing") return `The garage door is ${r.state}.`;
  const how = r.sinceMs === null ? "" : `, and has been for ${spokenDuration(r.sinceMs)}`;
  return `The garage door is ${r.state}${how}.`;
}

const POLL_MS = 1000;
const POLL_LIMIT_MS = 6500; // a tool must finish in under 8 seconds

export const garageStatus = (deps: ToolDeps) =>
  defineTool({
    name: "garage_status",
    description:
      "Is the garage door open or closed, and for how long. After closing or opening the garage, call this with wait_for set to the state you expect, to hear the real final state (the door takes about 15 seconds).",
    schema: z.object({ wait_for: z.enum(["open", "closed"]).optional() }),
    risk: "read",
    timeoutMs: 7500,
    handler: async (args, ctx) => {
      let r = await readGarage(deps, ctx.now);
      const started = Date.now();
      while (args.wait_for && r.state !== args.wait_for && Date.now() - started < POLL_LIMIT_MS) {
        await wait(deps, POLL_MS);
        r = await readGarage(deps, new Date(ctx.now.getTime() + (Date.now() - started)));
      }
      const note = args.wait_for && r.state !== args.wait_for ? ` It hasn't reached ${args.wait_for} yet.` : "";
      const opener = r.opener || r.state === "unavailable" ? "" : " The opener isn't answering, so I couldn't operate it.";
      return {
        speech: `${garageSentence(r)}${note}${opener}`,
        data: { state: r.state, minutes_in_state: r.sinceMs === null ? null : Math.round(r.sinceMs / 60_000), opener_online: r.opener, reached_expected_state: args.wait_for ? r.state === args.wait_for : null },
      };
    },
  });
