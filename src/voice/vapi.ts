import { z } from "zod";

// The ONLY file that knows what Vapi's messages look like. Everything else works with the plain types below, so moving to
// another voice provider means rewriting this file and push.ts, not the tools. Shapes follow docs.vapi.ai (Server URL events,
// custom tools); fields the docs do not show are read defensively and checked against a real call.

export interface CallInfo {
  id: string;
  direction: "inbound" | "outbound" | null;
  /** The other party's number (E.164): who phoned me, or whom Jarvis phoned. */
  number: string | null;
}
export interface ToolRequest {
  id: string;
  name: string;
  args: unknown;
}
export interface EndReport {
  endedReason: string | null;
  cost: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

const callSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().optional(),
    customer: z.object({ number: z.string().optional() }).loose().optional(),
  })
  .loose();

export function parseCall(raw: unknown): CallInfo | null {
  const parsed = callSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { id, type, customer } = parsed.data;
  return { id, direction: type === "inboundPhoneCall" ? "inbound" : type === "outboundPhoneCall" ? "outbound" : null, number: customer?.number ?? null };
}

/** The "message" of a Vapi server request, or null if the body is not one. */
export function messageOf(body: unknown): { type: string; [key: string]: unknown } | null {
  const msg = (body as { message?: unknown } | null)?.message;
  if (typeof msg !== "object" || msg === null || typeof (msg as { type?: unknown }).type !== "string") return null;
  return msg as { type: string };
}

const asObject = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The tool calls in a "tool-calls" message. Arguments may arrive as an object or as a JSON string. */
export function parseToolCalls(message: Record<string, unknown>): ToolRequest[] {
  const list = Array.isArray(message.toolCallList) ? message.toolCallList : Array.isArray(message.toolWithToolCallList) ? message.toolWithToolCallList.map((x) => asObject(x)?.toolCall) : [];
  const out: ToolRequest[] = [];
  for (const item of list) {
    const tc = asObject(item);
    if (!tc || typeof tc.id !== "string") continue;
    const fn = asObject(tc.function);
    const name = typeof fn?.name === "string" ? fn.name : typeof tc.name === "string" ? tc.name : "";
    let args: unknown = fn?.arguments ?? tc.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = null;
      }
    }
    out.push({ id: tc.id, name, args });
  }
  return out;
}

/** What Vapi wants back: HTTP 200 and one result (a flat string) or error (a flat string) per tool call. */
export const toolResponse = (items: { id: string; name: string; result?: string; error?: string }[]) => ({
  results: items.map((i) => (i.error !== undefined ? { toolCallId: i.id, name: i.name, error: i.error } : { toolCallId: i.id, name: i.name, result: i.result ?? "" })),
});

export function parseEndReport(message: Record<string, unknown>): EndReport {
  const call = asObject(message.call);
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    endedReason: str(message.endedReason) ?? str(call?.endedReason),
    cost: num(message.cost) ?? num(call?.cost),
    startedAt: str(message.startedAt) ?? str(call?.startedAt),
    endedAt: str(message.endedAt) ?? str(call?.endedAt),
  };
}
