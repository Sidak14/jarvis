import type Database from "better-sqlite3";
import type { WebhookHandler } from "../webhooks";
import { applyLocation, parseLocation, type PersonKey } from "./store";

/** POST /webhook/location/<me|mom> with {"kind": "location", "place": "home|work|gym", "event": "enter|leave"}. */
export function createLocationWebhook(opts: { db: Database.Database; person: PersonKey; now?: () => Date; onArriveHome?: () => void }): WebhookHandler {
  return ({ body, rawText, log }) => {
    const report = parseLocation(body);
    if (!report) {
      log(`not a location report: ${rawText.slice(0, 200)}`);
      return { status: 400, body: { error: 'send {"kind": "location", "place": "home|work|gym", "event": "enter|leave"}' } };
    }
    const where = applyLocation(opts.db, opts.person, report, (opts.now ?? (() => new Date()))());
    log(`${opts.person} ${report.event} ${report.place}: now ${where}`);
    if (report.place === "home" && report.event === "enter") opts.onArriveHome?.();
    return { status: 202, body: { ok: true, location: where } };
  };
}
