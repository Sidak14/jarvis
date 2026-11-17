import { z } from "zod";
import { defineTool } from "../registry";
import { listSpoken, words } from "../speak";
import type { ToolDeps } from "./deps";
import { garageSentence, readGarage } from "./garage";

/** The garage, plus which allowlisted lights are on right now. */
export const homeStatus = (deps: ToolDeps) =>
  defineTool({
    name: "home_status",
    description: "A quick look at the house: the garage door and which lights are on.",
    schema: z.object({}),
    risk: "read",
    timeoutMs: 6000,
    handler: async (_args, ctx) => {
      if (!deps.ha) return { speech: "I can't reach Home Assistant right now.", data: { available: false } };
      const garage = await readGarage(deps, ctx.now);
      const states = await deps.ha.read(deps.entities.lights.map((l) => l.entity));
      const on = deps.entities.lights.filter((l) => states[l.entity].state === "on").map((l) => l.name);
      const unreadable = deps.entities.lights.filter((l) => states[l.entity].state === "unavailable").length;
      const lights = on.length === 0 ? "No lights are on." : on.length === 1 ? `The ${on[0]} is on.` : `${words(on.length)} lights are on: ${listSpoken(on)}.`;
      return {
        speech: `${garageSentence(garage)} ${lights}`,
        data: { garage: garage.state, lights_on: on, lights_unreadable: unreadable },
      };
    },
  });
