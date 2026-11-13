/* Fridge screen. Written for old browsers (Samsung Family Hub): plain ES2015, fetch + promises, no libraries.
   Two screens: the lock (a keypad) and the home (the lights). The code is checked by the server, not here: this file
   only collects the last 7 keys and asks. */
(function () {
  "use strict";

  var body = document.body;
  var CODE_LENGTH = parseInt(body.getAttribute("data-code-length"), 10) || 7;
  var IDLE_MS = parseInt(body.getAttribute("data-idle-ms"), 10) || 300000;
  var POLL_MS = 4000;

  var lockEl = document.getElementById("lock");
  var homeEl = document.getElementById("home");
  var dotsEl = document.getElementById("dots");
  var keypadEl = document.getElementById("keypad");
  var lockMsg = document.getElementById("lock-msg");
  var homeMsg = document.getElementById("home-msg");
  var lightsEl = document.getElementById("lights");

  // ---- little helpers
  function api(method, path, data) {
    return fetch("/fridge" + path, {
      method: method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Fridge": "1" },
      body: data === undefined ? undefined : JSON.stringify(data),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) { return { status: res.status, json: json }; });
    });
  }
  function setMsg(el, text, isError) {
    el.textContent = text || " ";
    el.className = "fr-msg" + (isError ? " error" : "");
  }

  // ---- clock (the device's own time)
  function tickClock() {
    var now = new Date();
    var time = now.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", hour12: true });
    var date = now.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" });
    var times = document.querySelectorAll('[data-clock="time"]');
    var dates = document.querySelectorAll('[data-clock="date"]');
    for (var i = 0; i < times.length; i++) times[i].textContent = time;
    for (var j = 0; j < dates.length; j++) dates[j].textContent = date;
  }
  tickClock();
  setInterval(tickClock, 15000);

  // ---- icons
  var BULB =
    '<svg class="fr-icon" viewBox="0 0 64 64" aria-hidden="true">' +
    '<path class="glass" d="M32 6C20.4 6 12 14.6 12 25.4c0 7 3.6 11.6 7.6 15.6 2 2 3 4 3 6.4V50h18.8v-2.6c0-2.4 1-4.4 3-6.4C48.4 37 52 32.4 52 25.4 52 14.6 43.6 6 32 6z"/>' +
    '<path class="filament" fill="none" d="M26 30l6 8 6-8"/>' +
    '<rect class="base" x="22" y="52" width="20" height="4" rx="2"/><rect class="base" x="25" y="58" width="14" height="4" rx="2"/></svg>';

  // The Sikh Khanda: a double-edged sword (khanda) in the middle, the circle (chakkar) around it, and two crossed
  // kirpans curving up either side. One gold gradient, like a Nishan Sahib.
  var KHANDA =
    '<svg class="fr-icon fr-khanda" viewBox="22 2 156 172" aria-hidden="true">' +
    '<defs><linearGradient id="khanda-gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6c964"/><stop offset="1" stop-color="#c47a1f"/></linearGradient></defs>' +
    '<g fill="url(#khanda-gold)">' +
    '<circle cx="100" cy="96" r="33" fill="none" stroke="url(#khanda-gold)" stroke-width="10"/>' +
    '<path d="M66 38A66 66 0 0 0 96 160A80 80 0 0 1 66 38Z"/>' +
    '<path transform="translate(200 0) scale(-1 1)" d="M66 38A66 66 0 0 0 96 160A80 80 0 0 1 66 38Z"/>' +
    '<path d="M100 6C107 22 114 44 114 68C114 84 111 96 109 106L109 146L118 146L118 155L82 155L82 146L91 146L91 106C89 96 86 84 86 68C86 44 93 22 100 6Z"/>' +
    '<circle cx="100" cy="164" r="8"/>' +
    '</g><path d="M100 20L100 104" stroke="#8a4f10" stroke-width="2" stroke-linecap="round" opacity="0.55"/></svg>';

  // ---- the lock
  var typed = ""; // the last CODE_LENGTH keys
  var count = 0; // how many keys so far (up to CODE_LENGTH), for the dots
  var busy = false;
  var again = false;
  var lockedOutUntil = 0;

  function paintDots(wrong) {
    var dots = dotsEl.children;
    for (var i = 0; i < dots.length; i++) dots[i].className = "fr-dot" + (i < count ? " on" : "");
    dotsEl.className = "fr-dots" + (wrong ? " wrong" : "");
  }
  function resetKeys() {
    typed = "";
    count = 0;
    paintDots(false);
  }

  function press(key) {
    if (Date.now() < lockedOutUntil) return;
    typed = (typed + key).slice(-CODE_LENGTH);
    if (count < CODE_LENGTH) count++;
    paintDots(false);
    setMsg(lockMsg, "");
    if (count >= CODE_LENGTH) tryUnlock();
  }

  function tryUnlock() {
    if (busy) { again = true; return; }
    busy = true;
    api("POST", "/unlock", { keys: typed }).then(function (r) {
      busy = false;
      if (r.json.ok) { again = false; resetKeys(); showHome(); return; }
      if (r.status === 429) {
        var secs = r.json.retryAfterSec || 60;
        lockedOutUntil = Date.now() + secs * 1000;
        keypadEl.className = "fr-keypad off";
        setMsg(lockMsg, "Too many tries. Try again in " + (secs > 90 ? Math.ceil(secs / 60) + " minutes" : secs + " seconds") + ".", true);
        resetKeys();
        setTimeout(function () { keypadEl.className = "fr-keypad"; setMsg(lockMsg, ""); }, secs * 1000);
        return;
      }
      paintDots(true); // wrong: keep typing, the last 7 keys count
      setTimeout(function () { paintDots(false); }, 500);
      if (again) { again = false; if (count >= CODE_LENGTH) tryUnlock(); }
    }).catch(function () {
      busy = false;
      setMsg(lockMsg, "Can't reach Jarvis. Try again.", true);
    });
  }

  keypadEl.addEventListener("click", function (e) {
    var target = e.target;
    while (target && target !== keypadEl && !target.getAttribute("data-key")) target = target.parentNode;
    if (target && target.getAttribute) {
      var key = target.getAttribute("data-key");
      if (key) press(key);
    }
  });

  // ---- the home (lights)
  var pollTimer = null;
  var idleTimer = null;
  var lastActive = Date.now();
  var built = false;
  var pending = {}; // id -> true while we wait for Home Assistant

  function showLock(message) {
    stopPolling();
    homeEl.hidden = true;
    lockEl.hidden = false;
    lightsEl.innerHTML = "";
    built = false;
    pending = {};
    resetKeys();
    setMsg(lockMsg, message || "", false);
  }
  function showHome() {
    lockEl.hidden = true;
    homeEl.hidden = false;
    setMsg(homeMsg, "");
    lastActive = Date.now();
    refresh();
    pollTimer = setInterval(refresh, POLL_MS);
    idleTimer = setInterval(checkIdle, 15000);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    if (idleTimer) clearInterval(idleTimer);
    pollTimer = null;
    idleTimer = null;
  }

  var LABEL = { on: "On", off: "Off", unavailable: "Not reachable" };

  function build(lights) {
    lightsEl.innerHTML = "";
    lights.forEach(function (l) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fr-light";
      btn.setAttribute("data-id", l.id);
      btn.innerHTML = (l.icon === "khanda" ? KHANDA : BULB) + '<span class="fr-name"></span><span class="fr-state"></span>';
      btn.querySelector(".fr-name").textContent = l.name;
      btn.addEventListener("click", function () { toggle(l.id); });
      lightsEl.appendChild(btn);
    });
    built = true;
  }
  function paint(lights) {
    if (!built) build(lights);
    lights.forEach(function (l) {
      var btn = lightsEl.querySelector('[data-id="' + l.id + '"]');
      if (!btn || pending[l.id]) return; // don't fight a tap that is still being sent
      btn.setAttribute("data-state", l.state);
      btn.setAttribute("aria-pressed", l.state === "on" ? "true" : "false");
      btn.querySelector(".fr-state").textContent = LABEL[l.state] || l.state;
    });
  }

  function refresh() {
    api("GET", "/api/lights").then(function (r) {
      if (r.status === 401) { showLock("Locked."); return; }
      if (!r.json.lights) { setMsg(homeMsg, r.json.error || "Can't read the lights.", true); return; }
      setMsg(homeMsg, "");
      paint(r.json.lights);
    }).catch(function () { setMsg(homeMsg, "Can't reach Jarvis.", true); });
  }

  function toggle(id) {
    var btn = lightsEl.querySelector('[data-id="' + id + '"]');
    if (!btn || pending[id]) return;
    var state = btn.getAttribute("data-state");
    if (state === "unavailable") { setMsg(homeMsg, "That one isn't reachable right now.", true); return; }
    var on = state !== "on"; // we say on or off, never "toggle", so a double tap can't flip it twice
    pending[id] = true;
    btn.className = "fr-light pending";
    btn.setAttribute("data-state", on ? "on" : "off");
    btn.querySelector(".fr-state").textContent = on ? "On" : "Off";
    api("POST", "/api/lights/" + id, { on: on }).then(function (r) {
      if (r.status === 401) { showLock("Locked."); return; }
      if (!r.json.ok) setMsg(homeMsg, r.json.error || "That didn't work.", true);
      else setMsg(homeMsg, "");
    }).catch(function () {
      setMsg(homeMsg, "Can't reach Jarvis.", true);
    }).then(function () {
      setTimeout(function () {
        pending[id] = false;
        btn.className = "fr-light";
        refresh();
      }, 700);
    });
  }

  // ---- locking: the button, and after a quiet spell
  document.getElementById("lock-now").addEventListener("click", function () {
    api("POST", "/lock").then(function () { showLock(""); }, function () { showLock(""); });
  });
  function checkIdle() {
    if (Date.now() - lastActive > IDLE_MS) {
      api("POST", "/lock").then(function () { showLock(""); }, function () { showLock(""); });
    }
  }
  ["touchstart", "mousedown", "keydown"].forEach(function (ev) {
    document.addEventListener(ev, function () { lastActive = Date.now(); }, true);
  });

  // If this browser already holds a live session (a refresh of the page), go straight in.
  api("GET", "/api/session").then(function (r) {
    if (r.json.unlocked) showHome();
  }).catch(function () {});
})();
