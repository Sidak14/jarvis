import { h } from "../ui/html";

// The one HTML file of the home screen. It is an empty frame: fridge.js fills it from /dashboard/api/state and /api/week.
// Samsung Family Hub browsers are old: plain HTML and CSS, no framework, nothing fancy (see public/fridge.js).

export const HOME_ASSET_VERSION = "6";

export function homePage(): string {
  return h`<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex">
<title>Home · Jarvis</title>
<link rel="stylesheet" href="/dashboard/assets/fridge.css?v=${HOME_ASSET_VERSION}">
<script src="/dashboard/assets/fridge.js?v=${HOME_ASSET_VERSION}" defer></script>
</head><body class="home">
<div class="screen">

  <div class="top">
    <section class="card week" aria-label="Next 7 days">
      <div class="week-head"><h2>Next 7 days</h2><span class="week-today" id="week-today">&nbsp;</span></div>
      <p class="week-sub">Times Gurveer is busy</p>
      <div class="days" id="days"></div>
    </section>
    <section class="people" id="people" aria-label="Who is where"></section>
  </div>

  <section class="card lights" aria-label="Lights">
    <h2 class="label">Lights</h2>
    <div class="lights-grid" id="lights"></div>
  </section>

  <section class="card garage" aria-label="Garage door">
    <h2 class="label">Garage</h2>
    <div class="garage-row">
      <div class="garage-door" aria-hidden="true"><div class="garage-slats" id="garage-slats"></div></div>
      <div class="garage-text"><div class="garage-status" id="garage-status">&nbsp;</div><div class="garage-note" id="garage-note">&nbsp;</div></div>
      <button type="button" class="garage-btn" id="garage-btn" disabled>&nbsp;</button>
    </div>
  </section>

  <p class="msg" id="msg" role="status" aria-live="polite">&nbsp;</p>
</div>
</body></html>`.value;
}
