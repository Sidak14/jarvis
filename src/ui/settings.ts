import { DEFS, GROUPS, parseSetting, settings, type Def, type Group } from "../settings";
import { Banner, Card, Section } from "./components";
import { h, raw, type Html } from "./html";

// The "Edit settings" panel on each dashboard page, and the code that saves it. Values come from src/settings/defs.ts; a change
// is live within a couple of seconds, no restart.

export interface Flash {
  ok?: string;
  err?: string;
}

/** What the last save said, from the redirect's query string (?saved=3 or ?err=...). */
export function flashFrom(query: Record<string, string | undefined>): Flash {
  const saved = Number(query.saved);
  return { ok: Number.isFinite(saved) && query.saved !== undefined ? (saved === 0 ? "Nothing changed." : `Saved ${saved} setting${saved === 1 ? "" : "s"}. It is live now.`) : undefined, err: query.err ? query.err.slice(0, 600) : undefined };
}

const show = (def: Def, value: number | string | boolean): string => (def.type === "bool" ? (value ? "on" : "off") : def.type === "lines" ? "(the built-in list)" : `${value}${"unit" in def && def.unit ? ` ${def.unit}` : ""}`);

function input(key: string, def: Def, value: number | string | boolean): Html {
  const name = `s.${key}`;
  switch (def.type) {
    case "number":
      return h`<input type="number" name="${name}" value="${value as number}" min="${def.min}" max="${def.max}" step="${def.step ?? (def.int ? 1 : "any")}" inputmode="decimal">`;
    case "bool":
      // The hidden field makes an unticked box send "0".
      return h`<input type="hidden" name="${name}" value="0"><label class="switch"><input type="checkbox" name="${name}" value="1"${raw(value ? " checked" : "")}> <span>${value ? "On" : "Off"}</span></label>`;
    case "choice":
      return h`<select name="${name}">${def.choices.map((c) => h`<option value="${c}"${raw(c === value ? " selected" : "")}>${c}</option>`)}</select>`;
    case "lines":
      return h`<textarea name="${name}" rows="${Math.min(18, String(value).split("\n").length + 1)}" spellcheck="false">${String(value)}</textarea>`;
  }
}

function flashBanner(flash?: Flash): Html | "" {
  if (flash?.err) return Banner("error", "Not saved", [{ text: flash.err }]);
  if (flash?.ok) return Banner("ok", flash.ok);
  return "";
}

/** The form for one group of settings. `back` is the page to come back to after saving. */
export function SettingsPanel(opts: { group: Group; back: string; flash?: Flash; open?: boolean }): Html {
  const keys = Object.keys(DEFS).filter((k) => DEFS[k].group === opts.group);
  const rows = keys.map((key) => {
    const def = DEFS[key];
    const value = settings.get(key);
    const custom = settings.isCustom(key);
    return h`<div class="setting${custom ? " changed" : ""}">
  <div class="setting-text"><label for="s-${key}"><b>${def.label}</b>${custom ? h` <span class="pill info">changed</span>` : ""}</label>${def.help ? h`<p class="muted">${def.help}</p>` : ""}<p class="muted">Default: ${show(def, settings.defaultFor(key))}</p></div>
  <div class="setting-input">${input(key, def, value)}${"unit" in def && def.unit && def.type === "number" ? h` <span class="muted">${def.unit}</span>` : ""}${custom ? h`<label class="reset"><input type="checkbox" name="reset.${key}" value="1"> reset to default</label>` : ""}</div>
</div>`;
  });
  const form = h`<form method="post" action="/settings/save" class="settings-form">
<input type="hidden" name="group" value="${opts.group}"><input type="hidden" name="back" value="${opts.back}">
${rows}
<p class="settings-actions"><button type="submit" class="btn primary">Save settings</button> <span class="muted">Takes effect straight away, no restart.</span></p>
</form>`;
  return h`<section class="settings" id="settings-${opts.group}">${flashBanner(opts.flash)}<details class="fold"${raw(opts.open || opts.flash?.err ? " open" : "")}><summary>${GROUPS[opts.group].title}</summary><p class="muted">${GROUPS[opts.group].blurb}</p>${form}</details></section>`;
}

/** The Jobs page panel: every job's schedule (a cron expression), editable. */
export function JobSchedulesPanel(opts: { jobs: { name: string; expression: string; defaultExpression: string }[]; back: string; flash?: Flash }): Html {
  const rows = opts.jobs.map(
    (j) => h`<div class="setting${j.expression !== j.defaultExpression ? " changed" : ""}">
  <div class="setting-text"><label for="cron-${j.name}"><b>${j.name}</b>${j.expression !== j.defaultExpression ? h` <span class="pill info">changed</span>` : ""}</label><p class="muted">Default: <code class="mono">${j.defaultExpression}</code></p></div>
  <div class="setting-input"><input id="cron-${j.name}" type="text" name="cron.${j.name}" value="${j.expression}" class="mono" spellcheck="false"></div>
</div>`,
  );
  return h`<section class="settings" id="settings-jobs">${flashBanner(opts.flash)}<details class="fold"${raw(opts.flash?.err ? " open" : "")}><summary>Job schedules</summary><p class="muted">Five parts: minute hour day month weekday (for example */5 * * * * is every 5 minutes). Clear a box to go back to the default. Takes effect at once.</p>
<form method="post" action="/settings/save" class="settings-form"><input type="hidden" name="group" value="jobs"><input type="hidden" name="back" value="${opts.back}">${rows}
<p class="settings-actions"><button type="submit" class="btn primary">Save schedules</button></p></form></details></section>`;
}

/** Add a block to the end of a page (just before </main>). */
export function appendToPage(html: string, block: Html | ""): string {
  const at = html.lastIndexOf("</main>");
  return at < 0 ? html : html.slice(0, at) + block.toString() + html.slice(at);
}

/** Save a submitted form for one group. Returns how many settings changed and what was wrong with the rest. */
export function saveGroup(group: Group, form: URLSearchParams): { saved: number; errors: string[] } {
  let saved = 0;
  const errors: string[] = [];
  for (const key of Object.keys(DEFS).filter((k) => DEFS[k].group === group)) {
    const def = DEFS[key];
    if (form.get(`reset.${key}`)) {
      if (settings.isCustom(key)) {
        settings.reset(key);
        saved++;
      }
      continue;
    }
    const values = form.getAll(`s.${key}`);
    if (!values.length) continue;
    const parsed = parseSetting(def, values[values.length - 1]);
    if (!parsed.ok) {
      errors.push(`${def.label}: ${parsed.error}`);
      continue;
    }
    if (String(parsed.value) === String(settings.get(key))) continue;
    if (String(parsed.value) === String(settings.defaultFor(key))) settings.reset(key);
    else settings.write(key, typeof parsed.value === "boolean" ? (parsed.value ? "1" : "0") : String(parsed.value));
    saved++;
  }
  return { saved, errors };
}

/** A same-site form post only: a page on another site cannot make the browser change my settings. */
export function sameSite(headers: { origin?: string; host?: string; secFetchSite?: string }): boolean {
  if (headers.secFetchSite && !["same-origin", "none"].includes(headers.secFetchSite)) return false;
  if (headers.origin) {
    try {
      return new URL(headers.origin).host === headers.host;
    } catch {
      return false;
    }
  }
  return true;
}

export { Card, Section };
