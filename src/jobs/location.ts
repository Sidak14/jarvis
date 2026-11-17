import { db } from "../db";
import { createLocationWebhook } from "../location/webhook";
import { registerWebhook } from "../webhooks";

export function registerLocation(): void {
  registerWebhook("location", createLocationWebhook({ db }));
}
