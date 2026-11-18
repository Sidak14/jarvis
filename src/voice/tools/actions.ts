import { z } from "zod";
import { defineTool, type ToolResult } from "../registry";
import { clean } from "../sanitize";
import { findLight } from "../entities";
import { wait, type ToolDeps } from "./deps";
import { readGarage } from "./garage";

// The tools that CHANGE something in Home Assistant. They run as soon as they are asked (no "are you sure?"); the caller is
// already known to be the owner's phone. Opening the garage also needs the spoken passphrase, checked here in code. Each tool
// checks the real state first and never sends a redundant command. With VOICE_HA_WRITES=dry they only say what they would do.
// The garage takes about 15 seconds, so Open and Close only START the door and answer at once; the person can keep talking,
// and watch.ts sends a quiet note into the call when the door has finished (or failed to move).

const POLL_MS = 1000;
const POLL_LIMIT_MS = 4000; // a tool must finish in under 8 seconds
const DRY_LOG = (what: string) => console.log(`[voice] DRY RUN: would ${what}`);

// ---- garage
async function moveGarage(deps: ToolDeps, want: "open" | "closed", callId: string, now: Date): Promise<ToolResult> {
  const verb = want === "open" ? "open" : "close";
  const r = await readGarage(deps, now);
  if (r.state === "unavailable") return { speech: `I can't read the garage door, so I won't try to ${verb} it.`, data: { sent: false, reason: "unreadable" } };
  if (r.state === want) return { speech: `The garage door is already ${want}. I didn't send anything.`, data: { sent: false, reason: "already", state: r.state } };
  if (r.state === "opening" || r.state === "closing") return { speech: `The garage door is ${r.state} already, so I won't press the button again.`, data: { sent: false, reason: "moving", state: r.state } };
  if (!r.opener) return { speech: `The opener isn't answering, so I can't ${verb} the door.`, data: { sent: false, reason: "opener_offline" } };

  if (deps.writes() === "dry") {
    DRY_LOG(`${verb} the garage door`);
    return { speech: `Test mode: I would ${verb} the garage door now. Nothing was sent.`, data: { sent: false, dry_run: true } };
  }

  await deps.ha!.call("cover", want === "open" ? "open_cover" : "close_cover", deps.entities.garage.cover);
  const started = Date.now();
  let after = r;
  // Home Assistant says "opening"/"closing" for 15 seconds after a press. Wait only until it has started moving.
  while (after.state === r.state && Date.now() - started < POLL_LIMIT_MS) {
    await wait(deps, POLL_MS);
    after = await readGarage(deps, new Date(now.getTime() + (Date.now() - started)));
  }
  if (after.state === "opening" || after.state === "closing") {
    deps.afterMove?.(callId, want);
    return {
      speech: `The garage door is ${after.state === "closing" ? "closing" : "opening"} now.`,
      data: { sent: true, state: after.state, final: false, note: "It takes about fifteen seconds. Carry on with the conversation: you will be told when it has finished or failed. Do not wait for it." },
    };
  }
  if (after.state === want) return { speech: `The garage door is ${want}.`, data: { sent: true, state: after.state, final: true } };
  return { speech: `That didn't go through: the garage door still shows ${after.state}.`, data: { sent: true, state: after.state, final: true, worked: false } };
}

export const closeGarage = (deps: ToolDeps) =>
  defineTool({
    name: "close_garage",
    description: "Close the garage door. Do it as soon as the person asks, without asking whether they are sure. It only starts the door and answers at once; carry on talking.",
    schema: z.object({}),
    risk: "write",
    timeoutMs: 7800,
    handler: (_args, ctx) => moveGarage(deps, "closed", ctx.callId, ctx.now),
  });

export const openGarage = (deps: ToolDeps) =>
  defineTool({
    name: "open_garage",
    description:
      "Open the garage door. Pass in `words` exactly what the person said when they asked, word for word. The tool decides whether opening is allowed. It only starts the door and answers at once; carry on talking. If it says it can't, say so and nothing more.",
    schema: z.object({ words: z.string().max(300).optional() }),
    risk: "write",
    timeoutMs: 7800,
    handler: (args, ctx) => {
      const refuse = (reason: string) => ({ speech: "I can't open the garage door.", data: { sent: false, reason } });
      switch (ctx.security.attempt(ctx.callId, args.words ?? "")) {
        case "ok":
          return moveGarage(deps, "open", ctx.callId, ctx.now);
        case "locked":
          return refuse("not_allowed");
        case "no_phrase":
          return refuse("not_set_up");
        default:
          return refuse("not_allowed");
      }
    },
  });

// ---- lights
export const lightsSet = (deps: ToolDeps) =>
  defineTool({
    name: "lights_set",
    description: "Turn one of the house lights on or off by its name (for example chandelier, driveway lights, courtyard). Do it as soon as the person asks, without asking whether they are sure.",
    schema: z.object({ name: z.string().min(1).max(60), state: z.enum(["on", "off"]) }),
    risk: "write",
    timeoutMs: 7800,
    handler: async (args) => {
      const light = findLight(deps.entities, args.name);
      if (!light) {
        const names = deps.entities.lights.slice(0, 6).map((l) => l.name).join(", ");
        return { speech: `I don't know a light called ${clean(args.name, 40)}. I can do ${names}, and others.`, data: { sent: false, reason: "unknown_light" } };
      }
      if (!deps.ha) return { speech: "I can't reach Home Assistant right now.", data: { sent: false, reason: "no_ha" } };
      const current = (await deps.ha.read([light.entity]))[light.entity].state;
      if (current === "unavailable") return { speech: `I can't reach the ${light.name} right now.`, data: { sent: false, reason: "unreachable" } };
      if (current === args.state) return { speech: `The ${light.name} is already ${args.state}. I didn't send anything.`, data: { sent: false, reason: "already" } };

      if (deps.writes() === "dry") {
        DRY_LOG(`turn the ${light.name} ${args.state}`);
        return { speech: `Test mode: I would turn the ${light.name} ${args.state}. Nothing was sent.`, data: { sent: false, dry_run: true } };
      }
      await deps.ha.call("switch", args.state === "on" ? "turn_on" : "turn_off", light.entity);
      const started = Date.now();
      let after = current;
      while (after !== args.state && Date.now() - started < POLL_LIMIT_MS) {
        await wait(deps, POLL_MS);
        after = (await deps.ha.read([light.entity]))[light.entity].state;
      }
      return after === args.state
        ? { speech: `The ${light.name} is ${args.state}.`, data: { sent: true, state: after, final: true } }
        : { speech: `I sent the command but the ${light.name} still shows ${after}.`, data: { sent: true, state: after, final: true, worked: false } };
    },
  });

