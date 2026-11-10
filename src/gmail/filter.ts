import type { EmailMessage } from "./message";

// The cheap code check that runs BEFORE any LLM call. An email that cannot be a payment receipt
// never costs a token. (Gmail's own search and category filters already removed most junk.)

// An amount: a currency symbol or code next to a number, OR a number with cents next to a word like
// total/amount/paid. (Plain "12.50" under "Total" has no symbol, and must not be missed.)
const MONEY = new RegExp(
  [
    String.raw`[$€£¥]\s?\d[\d,]*(?:\.\d{1,2})?`,
    String.raw`\b\d[\d,]*\.\d{2}\s?(?:AUD|USD|EUR|GBP|NZD|CAD|SGD|JPY)\b`,
    String.raw`\b(?:AUD|USD|EUR|GBP|NZD|CAD|SGD|JPY)\s?\d[\d,]*(?:\.\d{1,2})?`,
    String.raw`(?:total|amount|paid|price|charged?|due|subtotal|balance|fare|fee|cost)\D{0,30}\d[\d,]*\.\d{2}`,
  ].join("|"),
  "i",
);
const RECEIPT_WORDS = /receipt|invoice|bill|order|payment|paid|purchase|charge|transaction|subscription|renewal|booking|donation|expense/i;
const PROMO_WORDS = /newsletter|unsubscribe|webinar|\d+\s?% off|\bsale\b|\bdeals?\b|promo|coupon|giveaway/i;

/** Why this email should be skipped without asking the model, or null to go ahead. */
export function prefilter(email: EmailMessage): string | null {
  if (!email.text.trim()) return "empty body";
  if (PROMO_WORDS.test(email.subject) && !RECEIPT_WORDS.test(email.subject)) return "promo subject";
  if (!MONEY.test(email.text)) return "no amount found";
  return null;
}
