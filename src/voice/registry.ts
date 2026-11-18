import { z } from "zod";
import { sanitizeData, clean } from "./sanitize";
import type { CallSecurity } from "./session";
import { TOOL_MAX_MS } from "./settings";

// The tool registry. A tool that is not in here does not exist: the model can only ever ask for these by name, every
// argument is checked against the tool's schema, and every tool must finish in a few seconds.
// Tools are plain functions; nothing here knows about Vapi (see vapi.ts, the only file that does).
//
// Safety lives HERE, in code, not in the model's instructions. A call only reaches the tools if it came from the owner's own
// phone number, and then a tool does what it is asked straight away (no "are you sure?"). The one exception is opening the
// garage, which checks a spoken passphrase in code (tools/actions.ts, session.ts). Tools that change something are marked "write".
// Everything a tool returns is cleaned (one line, no quotes, cut short) before the model sees it.

export type Risk = "read" | "write";

export interface ToolContext {
  callId: string;
  now: Date;
  security: CallSecurity;
}
export interface ToolResult {
  /** What to say, short and speakable (no markdown). */
  speech: string;
  /** Structured facts for the model to answer follow-up questions from. */
  data?: unknown;
}
export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  risk: Risk;
  timeoutMs: number;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

export const defineTool = <S extends z.ZodType>(tool: Tool<S>): Tool<S> => tool;

export type ToolOutcome = { ok: true; result: ToolResult } | { ok: false; error: string };

const MAX_SPEECH_CHARS = 400;

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(tools: Tool[]) {
    for (const t of tools) {
      if (this.tools.has(t.name)) throw new Error(`duplicate tool: ${t.name}`);
      this.tools.set(t.name, t);
    }
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** The tools as JSON Schema, for the assistant config. */
  definitions(): { name: string; description: string; parameters: Record<string, unknown> }[] {
    return [...this.tools.values()].map((t) => {
      const { $schema, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown> & { properties?: Record<string, unknown> };
      void $schema;
      return { name: t.name, description: t.description, parameters };
    });
  }

  /** Run one tool through the safety rules. Never throws. */
  async run(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: "I don't have a tool for that." };
    const given = typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
    const parsed = tool.schema.safeParse(given);
    if (!parsed.success) return { ok: false, error: "That request wasn't in the right form." };
    const args = parsed.data;

    const limit = Math.min(tool.timeoutMs, TOOL_MAX_MS);
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve(tool.handler(args, ctx)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), limit);
        }),
      ]);
      return { ok: true, result: finish(result) };
    } catch (err) {
      console.error(`[voice] tool ${name} failed: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message === "timeout" ? "That took too long." : "That didn't work." };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Whatever a tool returned: one line of speech, and every string in the data cleaned. */
const finish = (r: ToolResult): ToolResult => ({ speech: clean(r.speech, MAX_SPEECH_CHARS), data: sanitizeData(r.data ?? null) });
