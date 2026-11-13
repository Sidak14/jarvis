import { esc } from "../html";

// Safe HTML building. `h` is a tagged template: every value you put in ${...} is ESCAPED unless it is
// already Html (made by another h`...` or raw()). Merchant names, chat names and plan titles are untrusted,
// so with this there is no way to forget escaping: forgetting just shows the text.

export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Mark a string as already-safe HTML. Only use it for markup written in this codebase, never for data. */
export const raw = (value: string): Html => new Html(value);

export type Part = Html | string | number | boolean | null | undefined | Part[];

function render(part: Part): string {
  if (part instanceof Html) return part.value;
  if (Array.isArray(part)) return part.map(render).join("");
  if (part === null || part === undefined || part === false || part === true) return "";
  return esc(part);
}

export function h(strings: TemplateStringsArray, ...values: Part[]): Html {
  let out = strings[0];
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1];
  });
  return new Html(out);
}

/** Join several pieces (empty ones are skipped). */
export const join = (parts: Part[], separator = ""): Html => new Html(parts.map(render).filter(Boolean).join(separator));

export const empty = new Html("");
