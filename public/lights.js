/* The Lights page: every light, including the ones that aren't on the home screen. Needs home-common.js. */
(function () {
  "use strict";

  var grid = Home.lightGrid(document.getElementById("lights"), load);

  function load() {
    Home.api("GET", "/api/lights").then(function (r) {
      if (r.status === 403) { Home.setMsg("This screen isn't allowed in. Log in with an allowed email.", true); return; }
      if (!r.json.lights) { Home.setMsg(r.json.error || "Can't read the lights.", true); return; }
      Home.setMsg("");
      grid.paint(r.json.lights);
    }).catch(function () { Home.setMsg("Can't reach Jarvis.", true); });
  }
  Home.every(4000, load);
})();
