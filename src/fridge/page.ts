import { ASSET_VERSION } from "../ui/components";
import { h } from "../ui/html";
import { CODE_LENGTH } from "./auth";

// The one HTML file of the fridge screen. It holds the lock screen and an empty "home" that fridge.js fills with the
// lights AFTER the code is accepted, so the names of the lights are not in the page source while it is locked.
// Samsung Family Hub browsers are old: plain HTML and CSS, no framework, nothing fancy (see public/fridge.js).

export const FRIDGE_ASSET_VERSION = "2";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

export function fridgePage(opts: { idleMs: number }): string {
  const dots = Array.from({ length: CODE_LENGTH }, () => h`<span class="fr-dot"></span>`);
  const keys = KEYS.map((k) => h`<button type="button" class="fr-key" data-key="${k}">${k}</button>`);
  return h`<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex">
<title>Fridge · Jarvis</title>
<link rel="stylesheet" href="/fridge/assets/dashboard.css?v=${ASSET_VERSION}">
<link rel="stylesheet" href="/fridge/assets/fridge.css?v=${FRIDGE_ASSET_VERSION}">
<script src="/fridge/assets/fridge.js?v=${FRIDGE_ASSET_VERSION}" defer></script>
</head><body class="fridge" data-idle-ms="${opts.idleMs}" data-code-length="${CODE_LENGTH}">

<main id="lock" class="fr-lock">
  <div class="fr-clock"><p class="fr-time num" data-clock="time">&nbsp;</p><p class="fr-date" data-clock="date">&nbsp;</p></div>
  <section class="fr-panel" aria-label="Enter code">
    <header class="fr-panel-head"><span class="brand-mark" aria-hidden="true">J</span><h1 class="fr-title">Enter code</h1></header>
    <div class="fr-dots" id="dots" aria-hidden="true">${dots}</div>
    <p class="fr-msg" id="lock-msg" role="status" aria-live="polite">&nbsp;</p>
    <div class="fr-keypad" id="keypad">${keys}</div>
  </section>
</main>

<main id="home" class="fr-home" hidden>
  <header class="fr-home-head">
    <div class="fr-clock fr-clock-sm"><p class="fr-time num" data-clock="time">&nbsp;</p><p class="fr-date" data-clock="date">&nbsp;</p></div>
    <button type="button" class="fr-btn" id="lock-now">Lock</button>
  </header>
  <h1 class="fr-heading">Lights</h1>
  <div class="fr-lights" id="lights" role="group" aria-label="Lights"></div>
  <p class="fr-msg" id="home-msg" role="status" aria-live="polite">&nbsp;</p>
</main>

</body></html>`.value;
}
