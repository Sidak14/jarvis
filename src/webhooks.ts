// Webhooks that need the request body. POST /webhook/:name looks here first, then
// falls back to triggering the job with that name (see app.ts).
export interface WebhookContext {
  /** The parsed JSON body. Not trusted: validate it. */
  body: unknown;
  log: (message: string) => void;
}
export interface WebhookResult {
  status: 202 | 400 | 500;
  body: Record<string, unknown>;
}
export type WebhookHandler = (ctx: WebhookContext) => WebhookResult | Promise<WebhookResult>;

const handlers = new Map<string, WebhookHandler>();

export function registerWebhook(name: string, handler: WebhookHandler): void {
  if (handlers.has(name)) throw new Error(`webhook already registered: ${name}`);
  handlers.set(name, handler);
  console.log(`[webhooks] registered ${name}`);
}

export const getWebhook = (name: string): WebhookHandler | undefined => handlers.get(name);
