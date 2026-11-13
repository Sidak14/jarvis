import { BarList, Banner, Card, EmptyState, Facts, PageLayout, RelativeTime, Section, StatTile, StatusPill, TileRow } from "../components";
import { usd } from "../format";
import { h, join } from "../html";
import type { AiUsageVM } from "../vm/ai";
import type { ModuleStatus, OverviewVM } from "../vm/types";
import { stateKind } from "./shared";

// Overview: a health banner, six stat tiles, then one card per module.

function healthBanner(vm: OverviewVM) {
  if (vm.health.state === "ok") return Banner("ok", "Everything is running");
  const n = vm.health.items.length;
  return Banner(
    vm.health.state === "error" ? "error" : "warn",
    `${n} thing${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} attention`,
    vm.health.items.map((i) => ({ text: i.text, link: i.link, label: i.module })),
  );
}

function moduleCard(m: ModuleStatus, now: Date) {
  const pills = join([StatusPill(stateKind(m.state)), m.mode ? StatusPill(m.mode === "dry" ? "dry" : "live") : ""], " ");
  const body = h`<p class="module-summary">${m.summary}</p>
${m.issues.length ? h`<ul class="banner-list issues">${m.issues.map((i) => h`<li>${i}</li>`)}</ul>` : ""}
<p class="note">Last OK: ${RelativeTime(m.lastOkAt, now, "no successful run yet")}</p>
<details><summary>Details</summary>${Facts(m.facts.map((f) => ({ label: f.label, value: f.value })))}</details>`;
  return Card({ title: m.name, pill: pills, body, href: m.link, id: m.key });
}

function aiCard(ai: AiUsageVM) {
  const body = h`<p class="module-summary">${usd(ai.spendUsd)} of ${usd(ai.capUsd, 0)} this month (estimate) · ${ai.callsToday} of ${ai.callCap} calls today</p>
${ai.byFeature.length
    ? BarList(ai.byFeature.map((f) => ({ label: f.label, value: f.costUsd, text: h`${usd(f.costUsd, 4)} <span class="muted">· ${f.calls} calls</span>` })))
    : EmptyState("No breakdown yet", "Calls are tagged by feature from now on; earlier spend is only in the total.")}
${ai.untaggedUsd > 0.00005 ? h`<p class="note">Earlier or untagged spend: ${usd(ai.untaggedUsd, 4)}</p>` : ""}`;
  return Card({ title: "AI spend", body, id: "ai" });
}

export function overviewPage(vm: OverviewVM & { ai: AiUsageVM }, now: Date): string {
  const body = h`${healthBanner(vm)}
${TileRow(vm.tiles.map((t) => StatTile({ label: t.label, value: t.value, sub: t.sub, state: t.state, href: t.href })))}
${Section("Modules", h`<div class="cards">${vm.modules.map((m) => moduleCard(m, now))}${aiCard(vm.ai)}</div>`)}`;
  return PageLayout({ title: "Overview", active: "overview", body, now });
}
