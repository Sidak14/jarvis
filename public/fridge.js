/* Home screen (/dashboard). Written for old browsers (Samsung Family Hub): plain ES5/ES2015, fetch + promises, no libraries.
   It only draws what /dashboard/api/state and /dashboard/api/week say, and sends taps back. Who may open the page is
   decided by the server (src/fridge/access.ts), not here. */
(function () {
  "use strict";

  var POLL_MS = 4000;
  var WEEK_MS = 5 * 60 * 1000;
  var daysEl = document.getElementById("days");
  var weekToday = document.getElementById("week-today");
  var peopleEl = document.getElementById("people");
  var lightsEl = document.getElementById("lights");
  var slatsEl = document.getElementById("garage-slats");
  var statusEl = document.getElementById("garage-status");
  var noteEl = document.getElementById("garage-note");
  var btnEl = document.getElementById("garage-btn");
  var msgEl = document.getElementById("msg");

  function api(method, path, data) {
    return fetch("/dashboard" + path, {
      method: method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Fridge": "1" },
      body: data === undefined ? undefined : JSON.stringify(data),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) { return { status: res.status, json: json }; });
    });
  }
  function setMsg(text, isError) {
    msgEl.textContent = text || " ";
    msgEl.className = "msg" + (isError ? " error" : "");
  }
  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

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

  // ---- next 7 days
  function paintWeek(days) {
    daysEl.innerHTML = "";
    if (days.length) weekToday.textContent = days[0].dow + " " + days[0].num + " " + days[0].month;
    days.forEach(function (d) {
      var row = el("div", "day" + (d.today ? " today" : ""));
      var date = el("div", "day-date");
      date.appendChild(el("div", "day-dow", d.today ? "Today" : d.dow));
      date.appendChild(el("div", "day-num", String(d.num)));
      var busy = el("div", "day-busy");
      d.busy.forEach(function (t) {
        var chip = el("div", "busy");
        chip.appendChild(el("b", "", "Busy"));
        chip.appendChild(el("span", "", t));
        busy.appendChild(chip);
      });
      if (!d.busy.length) busy.appendChild(el("div", "free", "Free all day"));
      row.appendChild(date);
      row.appendChild(busy);
      daysEl.appendChild(row);
    });
  }
  function loadWeek() {
    api("GET", "/api/week").then(function (r) {
      if (r.json.days) paintWeek(r.json.days);
      else {
        daysEl.innerHTML = "";
        daysEl.appendChild(el("div", "free", r.json.error || "Can't read the calendar."));
      }
    }).catch(function () {});
  }

  // ---- who is where
  var HOUSE = "M4 11l8-7 8 7M6 10v10h12V10";
  var PIN = "M12 21s-6-5.5-6-10a6 6 0 1 1 12 0c0 4.5-6 10-6 10zM12 8.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z";
  function paintPeople(people) {
    peopleEl.innerHTML = "";
    people.forEach(function (p) {
      var home = p.where === "Home";
      var tile = el("div", "person" + (home ? " home" : ""));
      tile.appendChild(el("div", "avatar", p.name.charAt(0)));
      var text = el("div", "person-text");
      text.appendChild(el("div", "person-name", p.name));
      var where = el("div", "person-where");
      where.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + (home ? HOUSE : PIN) + '"/></svg>';
      where.appendChild(el("span", "", p.where || "Not known yet"));
      text.appendChild(where);
      tile.appendChild(text);
      peopleEl.appendChild(tile);
    });
  }

  // ---- lights
  var LABEL = { on: "On", off: "Off", unavailable: "Not reachable" };
  var built = false;
  var pending = {}; // id -> true while we wait for Home Assistant
  function buildLights(lights) {
    lightsEl.innerHTML = "";
    lights.forEach(function (l) {
      var btn = el("button", "light");
      btn.type = "button";
      btn.setAttribute("data-id", l.id);
      btn.innerHTML = (l.icon === "khanda" ? KHANDA : BULB) + '<span><span class="light-name"></span><span class="light-state"></span></span>';
      btn.querySelector(".light-name").textContent = l.name;
      btn.addEventListener("click", function () { toggle(l.id); });
      lightsEl.appendChild(btn);
    });
    built = true;
  }
  function paintLights(lights) {
    if (!built) buildLights(lights);
    lights.forEach(function (l) {
      var btn = lightsEl.querySelector('[data-id="' + l.id + '"]');
      if (!btn || pending[l.id]) return; // don't fight a tap that is still being sent
      btn.setAttribute("data-state", l.state);
      btn.setAttribute("aria-pressed", l.state === "on" ? "true" : "false");
      btn.querySelector(".light-state").textContent = LABEL[l.state] || l.state;
    });
  }
  function toggle(id) {
    var btn = lightsEl.querySelector('[data-id="' + id + '"]');
    if (!btn || pending[id]) return;
    var state = btn.getAttribute("data-state");
    if (state === "unavailable") { setMsg("That one isn't reachable right now.", true); return; }
    var on = state !== "on"; // we say on or off, never "toggle", so a double tap can't flip it twice
    pending[id] = true;
    btn.className = "light pending";
    btn.setAttribute("data-state", on ? "on" : "off");
    btn.querySelector(".light-state").textContent = on ? "On" : "Off";
    api("POST", "/api/lights/" + id, { on: on }).then(function (r) {
      setMsg(r.json.ok ? "" : (r.json.error || "That didn't work."), !r.json.ok);
    }).catch(function () {
      setMsg("Can't reach Jarvis.", true);
    }).then(function () {
      setTimeout(function () { pending[id] = false; btn.className = "light"; refresh(); }, 700);
    });
  }

  // ---- garage
  var garage = "unavailable";
  var sure = false; // the first tap only asks "are you sure?"
  var sureTimer = null;
  var STATUS = { open: "Open", closed: "Closed", opening: "Opening\u2026", closing: "Closing\u2026", unavailable: "Not reachable" };
  var NOTE = { open: "Left open", closed: "Secure", opening: "Please wait", closing: "Please wait", unavailable: "The door sensor isn't answering" };
  function paintGarage(info) {
    garage = (info && info.state) || "unavailable";
    var opener = !!(info && info.opener);
    statusEl.textContent = STATUS[garage];
    statusEl.className = "garage-status" + (garage === "closed" ? " closed" : "");
    noteEl.textContent = !opener && garage !== "unavailable" ? "The opener is offline (no Wi-Fi), so buttons can't reach the door" : NOTE[garage];
    slatsEl.style.height = garage === "closed" || garage === "closing" ? "100%" : garage === "unavailable" ? "100%" : "14%";
    var canPress = (garage === "open" || garage === "closed") && opener;
    btnEl.disabled = !canPress;
    btnEl.className = "garage-btn" + (sure && canPress ? " sure" : "");
    btnEl.textContent = !canPress ? (garage === "opening" || garage === "closing" ? "Moving\u2026" : !opener ? "Opener offline" : "Not available") : sure ? (garage === "closed" ? "Tap again to open" : "Tap again to close") : (garage === "closed" ? "Open door" : "Close door");
  }
  btnEl.addEventListener("click", function () {
    if (btnEl.disabled) return;
    if (!sure) {
      sure = true;
      paintGarage(garage);
      sureTimer = setTimeout(function () { sure = false; paintGarage(garage); }, 4000);
      return;
    }
    clearTimeout(sureTimer);
    sure = false;
    var action = garage === "closed" ? "open" : "close";
    api("POST", "/api/garage", { action: action }).then(function (r) {
      setMsg(r.json.ok ? "" : (r.json.error || "That didn't work."), !r.json.ok);
      refresh();
    }).catch(function () { setMsg("Can't reach Jarvis.", true); });
  });

  // ---- keep it fresh
  function refresh() {
    api("GET", "/api/state").then(function (r) {
      if (r.status === 403) { setMsg("This screen isn't allowed in. Log in with an allowed email.", true); return; }
      if (r.json.people) paintPeople(r.json.people);
      if (r.json.lights) paintLights(r.json.lights);
      paintGarage(r.json.garage);
      setMsg(r.json.error || "", !!r.json.error);
    }).catch(function () { setMsg("Can't reach Jarvis.", true); });
  }
  refresh();
  loadWeek();
  setInterval(refresh, POLL_MS);
  setInterval(loadWeek, WEEK_MS);
})();
