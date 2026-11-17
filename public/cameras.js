/* The Cameras page: all six cameras as pictures that refresh, and a tap makes one big. Needs home-common.js.
   Pictures (not video) keep it light for the tunnel and for an old browser: each one reloads a moment after the last arrived. */
(function () {
  "use strict";

  var camsEl = document.getElementById("cams");
  var bigEl = document.getElementById("cam-big");
  var titleEl = document.getElementById("cam-title");
  var GRID_MS = 3000; // pause between pictures in the grid
  var BIG_MS = 1200; // ...and when one is big
  var open = null; // the camera shown big, or null
  var cams = [];

  /** Keeps `img` showing the latest picture of camera `id`: load the next one off-screen, swap it in, wait, repeat. */
  function keepFresh(img, id, wait, paused) {
    var stopped = false;
    function next() {
      if (stopped) return;
      if (document.hidden || (paused && paused())) { setTimeout(next, 500); return; }
      var loader = new Image();
      loader.onload = function () { if (!stopped) { img.src = loader.src; img.className = "cam-img live"; } setTimeout(next, wait()); };
      loader.onerror = function () { if (!stopped) img.className = "cam-img dead"; setTimeout(next, 5000); };
      loader.src = "/dashboard/api/camera/" + id + "?t=" + Date.now();
    }
    next();
    return function () { stopped = true; };
  }

  function showGrid(list) {
    camsEl.innerHTML = "";
    list.forEach(function (cam) {
      var tile = Home.el("button", "cam");
      tile.type = "button";
      var img = Home.el("img", "cam-img");
      img.alt = cam.name;
      tile.appendChild(img);
      tile.appendChild(Home.el("span", "cam-name", cam.name));
      tile.addEventListener("click", function () { showBig(cam); });
      camsEl.appendChild(tile);
      keepFresh(img, cam.id, function () { return GRID_MS; }, function () { return open !== null; }); // a big camera pauses the grid
    });
  }

  var stopBig = null;
  function showBig(cam) {
    open = cam;
    camsEl.hidden = true;
    bigEl.hidden = false;
    titleEl.textContent = cam.name;
    bigEl.innerHTML = "";
    var img = Home.el("img", "cam-img big");
    img.alt = cam.name;
    var close = Home.el("button", "rk cam-close", "Back to all cameras");
    close.type = "button";
    close.addEventListener("click", closeBig);
    bigEl.appendChild(img);
    bigEl.appendChild(close);
    stopBig = keepFresh(img, cam.id, function () { return BIG_MS; });
  }
  function closeBig() {
    if (stopBig) stopBig();
    open = null;
    bigEl.hidden = true;
    camsEl.hidden = false;
    titleEl.textContent = "Cameras";
  }

  Home.api("GET", "/api/cameras").then(function (r) {
    if (r.status === 403) { Home.setMsg("This screen isn't allowed in. Log in with an allowed email.", true); return; }
    cams = r.json.cameras || [];
    showGrid(cams);
  }).catch(function () { Home.setMsg("Can't reach Jarvis.", true); });
})();
