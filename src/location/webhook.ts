import type Database from "better-sqlite3";
import type { WebhookHandler } from "../webhooks";
import { applyLocation, parseLocation } from "./store";

/** POST /webhook/location with {"kind": "location", "place": "home|work|gym", "event": "enter|leave"}. */
export function createLocationWebhook(opts: { db: Database.Database; now?: () => Date }): WebhookHandler {
  return ({ body, rawText, log }) => {
    const report = parseLocation(body);
    if (!report) {
      log(`not a location report: ${rawText.slice(0, 200)}`);
      return { status: 400, body: { error: 'send {"kind": "location", "place": "home|work|gym", "event": "enter|leave"}' } };
    }
    const where = applyLocation(opts.db, report, (opts.now ?? (() => new Date()))());
    log(`${report.event} ${report.place}: now ${where}`);
    return { status: 202, body: { ok: true, location: where } };
  };
}
