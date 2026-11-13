// Jarvis dashboard: tiny vanilla JS. Everything works without it (filters are plain GET forms, tables are plain tables);
// this only adds sorting, expandable rows, instant filters, live "x min ago" text and an optional 60s auto-refresh.
(function () {
  "use strict";

  // ---- Expandable rows
  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("button.expand");
    if (!btn) return;
    var detail = document.getElementById(btn.getAttribute("aria-controls"));
    if (!detail) return;
    var open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", open ? "false" : "true");
    btn.setAttribute("aria-label", open ? "Show details" : "Hide details");
    detail.hidden = open;
  });

  // ---- Sorting: click a column heading. A row and its detail row move together.
  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("button.sort");
    if (!btn) return;
    var table = btn.closest("table");
    var th = btn.closest("th");
    var col = Number(btn.getAttribute("data-col"));
    var numeric = btn.getAttribute("data-sort") === "num";
    var dir = th.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
    table.querySelectorAll("th").forEach(function (x) { x.removeAttribute("aria-sort"); });
    th.setAttribute("aria-sort", dir);
    var body = table.tBodies[0];
    var pairs = [];
    Array.prototype.forEach.call(body.rows, function (row) {
      if (row.classList.contains("detail")) return;
      var next = row.nextElementSibling;
      pairs.push({ row: row, detail: next && next.classList.contains("detail") ? next : null });
    });
    function key(p) {
      var cell = p.row.cells[col];
      var v = cell.getAttribute("data-sort");
      if (v === null) v = cell.textContent.trim();
      return numeric ? Number(v) : String(v).toLowerCase();
    }
    pairs.sort(function (a, b) {
      var x = key(a), y = key(b);
      var c = x < y ? -1 : x > y ? 1 : 0;
      return dir === "ascending" ? c : -c;
    });
    pairs.forEach(function (p) { body.appendChild(p.row); if (p.detail) body.appendChild(p.detail); });
  });

  // ---- Filters: submit the form when a choice changes (search waits for a pause in typing).
  document.querySelectorAll("form[data-autosubmit]").forEach(function (form) {
    var timer;
    form.addEventListener("change", function () { form.submit(); });
    form.addEventListener("input", function (e) {
      if (e.target.type !== "search") return;
      clearTimeout(timer);
      timer = setTimeout(function () { form.submit(); }, 500);
    });
    var go = form.querySelector("button[type=submit]");
    if (go) go.hidden = true; // not needed once the form submits itself (still there without JS)
  });

  // ---- "5 min ago" text stays fresh
  function rel(ms) {
    var s = Math.round(ms / 1000), a = Math.abs(s);
    if (a < 45) return s > 0 ? "in under a minute" : "just now";
    var t = a < 5400 ? Math.max(1, Math.round(a / 60)) + " min" : a < 129600 ? Math.round(a / 3600) + " h" : Math.round(a / 86400) + " days";
    return s > 0 ? "in " + t : t + " ago";
  }
  function tick() {
    document.querySelectorAll("time.rel").forEach(function (el) {
      var t = Date.parse(el.getAttribute("datetime"));
      if (!isNaN(t)) el.textContent = rel(t - Date.now());
    });
  }
  tick();
  setInterval(tick, 30000);

  // ---- Optional auto-refresh every 60 seconds (remembered in this browser)
  var box = document.getElementById("auto-refresh");
  if (box) {
    var KEY = "jarvis-auto-refresh";
    try { box.checked = localStorage.getItem(KEY) === "1"; } catch (e) { /* storage blocked: fine */ }
    var timer = null;
    function apply() {
      clearInterval(timer);
      if (box.checked) {
        timer = setInterval(function () {
          var typing = document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
          if (!document.hidden && !typing) location.reload();
        }, 60000);
      }
    }
    box.addEventListener("change", function () {
      try { localStorage.setItem(KEY, box.checked ? "1" : "0"); } catch (e) { /* ignore */ }
      apply();
    });
    apply();
  }
})();
