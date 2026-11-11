import { config } from "../config";
import { db } from "../db";
import { GmailAuth } from "./auth";

/** The one shared Gmail login for the whole server. */
export const gmailAuth = new GmailAuth(
  db,
  config.GMAIL_CLIENT_ID ?? "",
  config.GMAIL_CLIENT_SECRET ?? "",
  config.GMAIL_REDIRECT_URI,
  fetch,
  config.GMAIL_CONSENT_DAYS,
);
