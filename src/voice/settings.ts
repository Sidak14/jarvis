// Voice: every knob in one place.

export const TIMEZONE = "Australia/Sydney";

/** A tool must answer within this (Vapi waits; the caller hears silence). */
export const TOOL_MAX_MS = 8000;
/** Hard limit on a call, set on the Vapi assistant. */
export const MAX_CALL_SECONDS = 300;
/** Hang up after this long without anyone speaking. */
export const SILENCE_TIMEOUT_SECONDS = 30;
/** Free text from tools (plan titles, merchants...) is cut to this many characters before the model sees it. */
export const MAX_TEXT_CHARS = 80;

/** What the assistant says first when I phone it. */
export const FIRST_MESSAGE = "Jarvis here. What do you need?";
/** What a stranger hears (the call is never connected to the model). */
export const STRANGER_MESSAGE = "Sorry, I can't help with this call. Goodbye.";
export const DISABLED_MESSAGE = "Voice control is switched off right now.";
