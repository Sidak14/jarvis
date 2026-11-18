import { loadEntities } from "../../voice/entities";
import { Card, Facts, PageLayout, Section } from "../components";
import { h } from "../html";
import { SettingsPanel, type Flash } from "../settings";

// The Home Assistant page: everything about the garage and the house that I can change without a restart. The garage and light
// entities themselves are listed in voice/entities.yaml (the garage) and in the lights setting below.

export function homeSettingsPage(now: Date, flash: Flash): string {
  const g = loadEntities().garage;
  const body = h`${SettingsPanel({ group: "home", back: "/home-assistant", flash, open: true })}
${Section("The garage entities", Card({ title: "Wired in voice/entities.yaml", body: Facts([{ label: "Door", value: g.cover }, { label: "Status", value: g.status }, { label: "Tilt sensor", value: g.sensor }, { label: "Opener on Wi-Fi", value: g.opener }]), footer: "These are the Home Assistant entities themselves, so they stay in the file." }))}`;
  return PageLayout({ title: "Home Assistant", active: "home", body, now, subtitle: "The garage, who triggers what, and the lights voice can switch" });
}
