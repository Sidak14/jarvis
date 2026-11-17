/* Shared by every page of the home screen (/dashboard). Old browsers (Samsung Family Hub): plain ES5/ES2015, no libraries.
   It only draws what /dashboard/api/... says and sends taps back. Who may open the page is decided by the server
   (src/fridge/access.ts), not here. */
(function () {
  "use strict";
  var Home = (window.Home = {});

  var msgEl = document.getElementById("msg");

  /** Calls /dashboard<path>. Resolves to { status, json }. */
  Home.api = function (method, path, data) {
    return fetch("/dashboard" + path, {
      method: method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Fridge": "1" },
      body: data === undefined ? undefined : JSON.stringify(data),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) { return { status: res.status, json: json }; });
    });
  };
  Home.setMsg = function (text, isError) {
    msgEl.textContent = text || " ";
    msgEl.className = "msg" + (isError ? " error" : "");
  };
  Home.el = function (tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  /** Runs fn now and then every `ms`, but not while the screen is hidden. */
  Home.every = function (ms, fn) {
    fn();
    setInterval(function () { if (!document.hidden) fn(); }, ms);
  };

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

  Home.BULB = BULB;
  Home.KHANDA = KHANDA;

  // ---- a grid of light buttons (the home screen and the Lights page)
  var LABEL = { on: "On", off: "Off", unavailable: "Not reachable", locked: "Locked" };
  /** `reload` is called after a tap, to read the real state. Returns { paint(lights) }. */
  Home.lightGrid = function (container, reload) {
    var built = false;
    var pending = {}; // id -> true while we wait for Home Assistant

    function build(lights) {
      container.innerHTML = "";
      lights.forEach(function (l) {
        var btn = Home.el("button", "light");
        btn.type = "button";
        btn.setAttribute("data-id", l.id);
        btn.innerHTML = (l.icon === "khanda" ? KHANDA : BULB) + '<span><span class="light-name"></span><span class="light-state"></span></span>';
        btn.querySelector(".light-name").textContent = l.name;
        btn.addEventListener("click", function () { toggle(l.id); });
        container.appendChild(btn);
      });
      built = true;
    }
    function toggle(id) {
      var btn = container.querySelector('[data-id="' + id + '"]');
      if (!btn || pending[id]) return;
      var state = btn.getAttribute("data-state");
      if (state === "locked") { Home.setMsg("That one is locked: switching it on trips the main circuit.", true); return; }
      if (state === "unavailable") { Home.setMsg("That one isn't reachable right now.", true); return; }
      var on = state !== "on"; // we say on or off, never "toggle", so a double tap can't flip it twice
      pending[id] = true;
      btn.className = "light pending";
      btn.setAttribute("data-state", on ? "on" : "off");
      btn.querySelector(".light-state").textContent = on ? "On" : "Off";
      Home.api("POST", "/api/lights/" + id, { on: on }).then(function (r) {
        Home.setMsg(r.json.ok ? "" : (r.json.error || "That didn't work."), !r.json.ok);
      }).catch(function () {
        Home.setMsg("Can't reach Jarvis.", true);
      }).then(function () {
        setTimeout(function () { pending[id] = false; btn.className = "light"; reload(); }, 700);
      });
    }
    return {
      paint: function (lights) {
        if (!built) build(lights);
        lights.forEach(function (l) {
          var btn = container.querySelector('[data-id="' + l.id + '"]');
          if (!btn || pending[l.id]) return; // don't fight a tap that is still being sent
          btn.setAttribute("data-state", l.state);
          btn.setAttribute("aria-pressed", l.state === "on" ? "true" : "false");
          btn.querySelector(".light-state").textContent = LABEL[l.state] || l.state;
        });
      },
    };
  };
})();
