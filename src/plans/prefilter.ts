// A cheap code check for DMs, so a private conversation only leaves this Mac (for the model) when it
// looks like it could be about a plan. No model, no cost. Deliberately a bit generous: a false yes
// costs a fraction of a cent, a false no loses a plan.

const WORDS = [
  // time and date
  "tonight", "tomorrow", "today", "tmrw", "tmr", "this week", "weekend", "next week", "this arvo", "arvo", "morning", "afternoon",
  "evening", "lunch", "dinner", "brunch", "breakfast", "midday", "noon", "midnight",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
  "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
  // joining in
  "coming", "come", "keen", "going", "are you in", "you in", "i'm in", "im in", "joining", "join", "rsvp", "invite", "invited", "free", "available", "can you make", "can't make", "cant make",
  // events
  "party", "birthday", "bday", "bbq", "barbie", "drinks", "pub", "beers", "gig", "concert", "festival", "movie", "movies", "match", "game", "footy", "trip", "camping",
  "wedding", "reservation", "booked", "booking", "tickets", "ticket", "meet", "meetup", "catch up", "catchup", "hang", "hangout", "plans", "plan", "event", "show", "sesh", "session",
];
const WORD_RE = new RegExp(`\\b(${WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
const CLOCK_RE = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b\d{1,2}:\d{2}\b/i;
const DATE_RE = /\b\d{1,2}[\/.-]\d{1,2}([\/.-]\d{2,4})?\b|\b\d{1,2}(st|nd|rd|th)\b/i;

export function looksLikePlan(text: string): boolean {
  return WORD_RE.test(text) || CLOCK_RE.test(text) || DATE_RE.test(text);
}
