// Gmail expenses: every knob in one place.

export const JOB_NAME = "gmail-expenses";
export const POLL_CRON = "0 * * * *"; // hourly

export const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]; // read-only, nothing else

/** Only look at mail from the last N days. */
export const LOOKBACK_DAYS = 7;
/** Most message ids to ask Gmail for, and most emails to actually read per run. */
export const LIST_LIMIT = 200;
export const MAX_EMAILS_PER_RUN = 30;

/**
 * Gmail search. Deliberately BROAD: anything that might be money in or out, in the subject or body,
 * from the last N days. Only social/forums are left out (receipts do not live there); promotions are
 * NOT excluded, because some receipts land there. The cheap code filter and the model sort the rest.
 * The cost of a wrong guess is a fraction of a cent, the cost of a miss is a missing expense.
 */
export const SEARCH_QUERY = (days: number) =>
  `newer_than:${days}d -in:spam -in:trash -category:social -category:forums ` +
  `(receipt OR receipts OR invoice OR invoices OR bill OR billing OR expense OR expenses ` +
  `OR payment OR paid OR order OR purchase OR charged OR charge OR transaction OR subscription ` +
  `OR renewal OR booking OR donation OR "tax invoice" OR "you paid" OR "amount due" OR "amount paid")`;

/** Most of an email's text sent to the model (head and tail; totals are often at the bottom). */
export const PROMPT_HEAD_CHARS = 4000;
export const PROMPT_TAIL_CHARS = 2000;

/** Sanity limits on what the model says. */
export const MAX_AMOUNT_CENTS = 1_000_000; // 10,000.00
export const MIN_CONFIDENCE = 0.5;
export const MAX_AGE_DAYS = 400;
export const DEFAULT_CURRENCY = "AUD";

/** The card shown in the Sheet for an expense that came from an email. */
export const EMAIL_CARD = "Email receipt";
