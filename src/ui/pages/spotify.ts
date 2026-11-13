import { Banner, DataTable, EmptyState, PageLayout, Progress, RelativeTime, Section, StatTile, StatusPill, TileRow, Card } from "../components";
import { dateTimeFull, duration } from "../format";
import { h } from "../html";
import type { LikedState, SpotifyVM } from "../vm/spotify";

// Spotify: tiles, Run now, the last run's output, and recently played songs with progress toward the like rule.

function likedPill(l: LikedState, dryRun: boolean) {
  switch (l) {
    case "jarvis":
      return StatusPill("ok", "Liked by Jarvis");
    case "liked":
      return StatusPill("ok", "Liked");
    case "due":
      return StatusPill("warn", dryRun ? "Would like (dry run)" : "Will like next run");
    case "not":
      return StatusPill("off", "Not liked");
    default:
      return StatusPill("off", "Not checked yet");
  }
}

export function spotifyPage(vm: SpotifyVM, now: Date, opts: { busy?: boolean } = {}): string {
  const connection = !vm.configured ? StatusPill("off", "Not configured") : vm.connected ? StatusPill("ok", "Connected") : StatusPill("error", "Not connected");
  const tiles = TileRow([
    StatTile({ label: "Connection", value: connection, sub: !vm.configured ? "add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET" : vm.connected ? undefined : h`<a href="/spotify/login">Log in to Spotify</a>` }),
    StatTile({ label: "Mode", value: vm.dryRun ? StatusPill("dry") : StatusPill("live"), sub: vm.dryRun ? "logs what it would like" : "really likes songs" }),
    StatTile({ label: "Rule", value: vm.ruleText, sub: `${vm.scheduleText} · ${vm.apiCallsToday} API calls today` }),
    StatTile({ label: "Next run", value: vm.nextRunAt ? RelativeTime(vm.nextRunAt, now) : "—", sub: vm.lastRunAt ? h`last ${RelativeTime(vm.lastRunAt, now)}` : "never run" }),
    StatTile({ label: "Liked this week", value: String(vm.likesThisWeek), sub: "by Jarvis" }),
  ]);

  const rows = vm.tracks.map((t) => ({
    cells: [
      { html: h`<strong>${t.name}</strong>`, sort: t.name.toLowerCase() },
      { html: h`${t.artists}`, sort: t.artists.toLowerCase() },
      { html: RelativeTime(t.lastPlayed, now), sort: t.lastPlayed.getTime() },
      { html: Progress(t.playsInWindow, vm.threshold, `${t.playsInWindow} of ${vm.threshold} plays in ${vm.windowDays} days`), sort: t.playsInWindow },
      { html: h`<span class="num">${t.playsTotal}</span>`, sort: t.playsTotal },
      likedPill(t.liked, vm.dryRun),
    ],
  }));
  const table = DataTable({
    caption: `Recently played (rule counts plays in the last ${vm.windowDays} days)`,
    id: "tracks",
    columns: [
      { label: "Song", sort: "text" },
      { label: "Artist", sort: "text" },
      { label: "Last played", sort: "num" },
      { label: `Plays in ${vm.windowDays} days`, sort: "num" },
      { label: "All stored", align: "right", sort: "num" },
      { label: "Liked" },
    ],
    rows,
    empty: EmptyState("No plays stored yet", "Run the job once Spotify is connected."),
  });

  const output = vm.run
    ? Card({
        id: "output",
        title: `Output of run #${vm.run.id}`,
        pill: vm.run.status === "success" ? StatusPill("ok") : vm.run.status === "running" ? StatusPill("info", "Running") : StatusPill("error", "Failing"),
        body: h`<p class="note"><time datetime="${vm.run.startedAt.toISOString()}" title="${dateTimeFull(vm.run.startedAt)}">Started ${RelativeTime(vm.run.startedAt, now)}</time> · ${duration(vm.run.durationMs)}</p><pre>${vm.run.log || "(no output)"}</pre>`,
      })
    : Card({ id: "output", title: "Output", body: EmptyState("No runs yet", 'Press "Run now".') });

  const body = h`${opts.busy ? Banner("info", "The job is already running (or disabled). Try again in a moment.") : ""}
${tiles}
<form class="row-actions" method="post" action="/spotify/run"><button class="btn" type="submit">Run now</button></form>
${output}
${Section("Recently played", table, vm.tracks.length)}`;
  return PageLayout({ title: "Spotify", active: "spotify", body, now });
}
