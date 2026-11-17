/* The home screen (/dashboard): next 7 days, who is where, the lights, the garage. Needs home-common.js. */
(function () {
  "use strict";

  var api = Home.api;
  var el = Home.el;
  var setMsg = Home.setMsg;
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
  var grid = Home.lightGrid(lightsEl, refresh);

  // ---- garage
  var garage = "unavailable";
  var sure = false; // the first tap only asks "are you sure?"
  var sureTimer = null;
  var STATUS = { open: "Open", closed: "Closed", opening: "Opening\u2026", closing: "Closing\u2026" };
  var NOTE = { open: "Left open", closed: "Secure", opening: "Please wait", closing: "Please wait" };
  var last = null; // the latest reading from the server, so a tap can repaint without asking again
  function paintGarage(info) {
    last = info;
    drawGarage();
  }
  function drawGarage() {
    var info = last;
    var sensor = (info && info.state) || "unavailable"; // the tilt sensor's reading
    var opener = !!(info && info.opener); // is the opener on Wi-Fi?
    // If either can't be read the door can't be trusted or pressed: say so and switch the button off.
    var unreadable = sensor === "unavailable" || !opener;
    garage = unreadable ? "unavailable" : sensor;
    statusEl.textContent = unreadable ? "Unreadable" : STATUS[garage];
    statusEl.className = "garage-status" + (unreadable ? " bad" : garage === "closed" ? " closed" : "");
    noteEl.textContent = unreadable ? (sensor === "unavailable" ? "The door sensor isn't answering" : "The opener isn't answering (no Wi-Fi)") : NOTE[garage];
    slatsEl.style.height = garage === "open" || garage === "opening" ? "14%" : "100%";
    var canPress = garage === "open" || garage === "closed";
    if (!canPress) sure = false;
    btnEl.disabled = !canPress;
    btnEl.className = "garage-btn" + (sure ? " sure" : "");
    btnEl.textContent = unreadable ? "Unreadable" : !canPress ? "Moving\u2026" : sure ? (garage === "closed" ? "Tap again to open" : "Tap again to close") : (garage === "closed" ? "Open door" : "Close door");
  }
  btnEl.addEventListener("click", function () {
    if (btnEl.disabled) return;
    if (!sure) {
      sure = true;
      drawGarage();
      sureTimer = setTimeout(function () { sure = false; drawGarage(); }, 4000);
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
      if (r.json.lights) grid.paint(r.json.lights);
      paintGarage(r.json.garage);
      setMsg(r.json.error || "", !!r.json.error);
    }).catch(function () { setMsg("Can't reach Jarvis.", true); });
  }
  refresh();
  loadWeek();
  setInterval(refresh, POLL_MS);
  setInterval(loadWeek, WEEK_MS);
})();
