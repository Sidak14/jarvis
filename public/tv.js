/* The TV page: a remote control for the living room TV. Needs home-common.js. The page sends key NAMES ("up", "vol_up"...);
   the server turns them into Samsung key codes. */
(function () {
  "use strict";

  var statusEl = document.getElementById("tv-status");
  var sourcesEl = document.getElementById("tv-sources");
  var volumeEl = document.getElementById("tv-volume");
  var shownSources = "";

  function paint(tv) {
    var parts = [tv.state === "on" ? "On" : tv.state === "off" ? "Off" : "Not reachable"];
    if (tv.state === "on" && tv.source) parts.push(tv.source);
    if (tv.state === "on" && tv.muted) parts.push("Muted");
    statusEl.textContent = parts.join(" · ");
    statusEl.className = "tv-status" + (tv.state === "on" ? " on" : "");
    volumeEl.textContent = tv.volume === null ? "Volume" : "Volume " + tv.volume;

    var key = tv.sources.join("|") + "|" + tv.source;
    if (key === shownSources) return;
    shownSources = key;
    sourcesEl.innerHTML = "";
    tv.sources.forEach(function (name) {
      var b = Home.el("button", "rk rk-source" + (name === tv.source ? " current" : ""), name);
      b.type = "button";
      b.addEventListener("click", function () { send({ source: name }); });
      sourcesEl.appendChild(b);
    });
  }

  function load() {
    Home.api("GET", "/api/tv").then(function (r) {
      if (r.status === 403) { Home.setMsg("This screen isn't allowed in. Log in with an allowed email.", true); return; }
      if (!r.json.tv) { Home.setMsg(r.json.error || "Can't read the TV.", true); return; }
      Home.setMsg("");
      paint(r.json.tv);
    }).catch(function () { Home.setMsg("Can't reach Jarvis.", true); });
  }

  function send(body) {
    Home.api("POST", "/api/tv", body).then(function (r) {
      Home.setMsg(r.json.ok ? "" : (r.json.error || "That didn't work."), !r.json.ok);
      setTimeout(load, 800);
    }).catch(function () { Home.setMsg("Can't reach Jarvis.", true); });
  }

  var keys = document.querySelectorAll("[data-key]");
  Array.prototype.forEach.call(keys, function (b) {
    b.addEventListener("click", function () { send({ key: b.getAttribute("data-key") }); });
  });
  Home.every(3000, load);
})();
