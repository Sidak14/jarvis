import { h, raw, type Html } from "../ui/html";

// The HTML files of the home screen. Each page is an empty frame that its script fills from /dashboard/api/...
// Samsung Family Hub browsers are old: plain HTML and CSS, no framework, nothing fancy (see public/*.js).

export const HOME_ASSET_VERSION = "8";

type Tab = "home" | "lights" | "tv" | "cameras";
const TABS: { key: Tab; label: string; href: string }[] = [
  { key: "home", label: "Home", href: "/dashboard" },
  { key: "lights", label: "Lights", href: "/dashboard/lights" },
  { key: "tv", label: "TV", href: "/dashboard/tv" },
  { key: "cameras", label: "Cameras", href: "/dashboard/cameras" },
];

function frame(opts: { tab: Tab; title: string; script: string; body: Html }): string {
  const tabs = TABS.map((t) => h`<a class="tab${raw(t.key === opts.tab ? " on" : "")}" href="${t.href}">${t.label}</a>`);
  return h`<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex">
<title>${opts.title} · Jarvis</title>
<link rel="stylesheet" href="/dashboard/assets/fridge.css?v=${HOME_ASSET_VERSION}">
<script src="/dashboard/assets/home-common.js?v=${HOME_ASSET_VERSION}" defer></script>
<script src="/dashboard/assets/${opts.script}?v=${HOME_ASSET_VERSION}" defer></script>
</head><body class="home">
<div class="screen">
${opts.body}
  <p class="msg" id="msg" role="status" aria-live="polite">&nbsp;</p>
  <nav class="tabs" aria-label="Pages">${tabs}</nav>
</div>
</body></html>`.value;
}

export function homePage(): string {
  return frame({
    tab: "home",
    title: "Home",
    script: "home.js",
    body: h`
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
  </section>`,
  });
}

export function lightsPage(): string {
  return frame({
    tab: "lights",
    title: "Lights",
    script: "lights.js",
    body: h`
  <section class="card page-card" aria-label="All lights">
    <h2 class="page-title">All lights</h2>
    <div class="lights-grid all" id="lights"></div>
  </section>`,
  });
}

function key(name: string, label: string, cls = ""): Html {
  return h`<button type="button" class="rk ${cls}" data-key="${name}">${label}</button>`;
}

export function tvPage(): string {
  return frame({
    tab: "tv",
    title: "TV",
    script: "tv.js",
    body: h`
  <section class="card page-card" aria-label="TV">
    <div class="tv-head"><h2 class="page-title">TV</h2><span class="tv-status" id="tv-status">&nbsp;</span></div>
    <div class="tv-row">
      ${key("power", "Power", "rk-power")}
      <div class="tv-sources" id="tv-sources"></div>
    </div>
    <div class="dpad">
      <span></span>${key("up", "▲")}<span></span>
      ${key("left", "◀")}${key("ok", "OK", "rk-ok")}${key("right", "▶")}
      <span></span>${key("down", "▼")}<span></span>
    </div>
    <div class="tv-row tv-row3">${key("back", "Back")}${key("home", "Home")}${key("menu", "Menu")}</div>
    <div class="tv-pair">
      <div class="rocker">${key("vol_up", "Vol +")}<span class="rocker-label" id="tv-volume">Volume</span>${key("vol_down", "Vol −")}</div>
      <div class="rocker">${key("ch_up", "Ch +")}<span class="rocker-label">Channel</span>${key("ch_down", "Ch −")}</div>
    </div>
    <div class="tv-row tv-row3">${key("mute", "Mute")}${key("play", "Play")}${key("pause", "Pause")}</div>
  </section>`,
  });
}

export function camerasPage(): string {
  return frame({
    tab: "cameras",
    title: "Cameras",
    script: "cameras.js",
    body: h`
  <section class="card page-card cams-card" aria-label="Cameras">
    <h2 class="page-title" id="cam-title">Cameras</h2>
    <div class="cams" id="cams"></div>
    <div class="cam-big" id="cam-big" hidden></div>
  </section>`,
  });
}
