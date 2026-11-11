import type { z } from "zod";
import type { Llm } from "./llm";

/** The model answered, but not with JSON that matches the schema (even after one retry). */
export class LlmJsonError extends Error {}

/**
 * Ask the model for a JSON object and check it against a zod schema. What comes back is typed:
 * either it matches the schema, or this throws. If the first reply is not usable the model is
 * asked once more. (Every call goes through `llm`, so the spend caps still apply.)
 */
export async function askJson<T>(llm: Llm, system: string, user: string, schema: z.ZodType<T>): Promise<T> {
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await llm.complete(system, user);
    // Allow ```json fences or a stray sentence around the object.
    const start = reply.indexOf("{");
    const end = reply.lastIndexOf("}");
    let data: unknown;
    try {
      data = JSON.parse(reply.slice(start, end + 1));
    } catch {
      problem = "reply was not JSON";
      continue;
    }
    const parsed = schema.safeParse(data);
    if (parsed.success) return parsed.data;
    problem = `reply did not match the schema (${parsed.error.issues[0]?.path.join(".") || "root"})`;
  }
  throw new LlmJsonError(`model ${problem}`);
}
