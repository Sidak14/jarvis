import { z } from "zod";
import { TOOL_MAX_MS } from "./settings";

// The tool registry. A tool that is not in here does not exist: the model can only ever ask for these by name, every
// argument is checked against the tool's schema, and every tool must finish in a few seconds.
// Tools are plain functions; nothing here knows about Vapi (see vapi.ts, the only file that does).

export type Risk = "read" | "write" | "danger";

export interface ToolContext {
  callId: string;
  now: Date;
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
      const { $schema, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
      void $schema;
      return { name: t.name, description: t.description, parameters };
    });
  }

  /** Run one tool: it must exist, its arguments must fit its schema, and it must finish in time. Never throws. */
  async run(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: "I don't have a tool for that." };
    const args = tool.schema.safeParse(rawArgs ?? {});
    if (!args.success) return { ok: false, error: "That request wasn't in the right form." };
    const limit = Math.min(tool.timeoutMs, TOOL_MAX_MS);
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve(tool.handler(args.data, ctx)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), limit);
        }),
      ]);
      return { ok: true, result };
    } catch (err) {
      console.error(`[voice] tool ${name} failed: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message === "timeout" ? "That took too long." : "That didn't work." };
    } finally {
      clearTimeout(timer);
    }
  }
}
