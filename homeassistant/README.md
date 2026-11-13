# Home Assistant (~/homeassistant)

Home Assistant Core, installed natively (no Docker). LAN only: http://192.168.4.54:8123

## Where things live
**The config, this README, `ha.sh` and the service file are part of the Jarvis git repo, in `~/jarvis/homeassistant/`.**
`~/homeassistant/config`, `~/homeassistant/ha.sh` and `~/homeassistant/README.md` are symlinks to them, so the service and old paths keep working.
Commit and push Home Assistant changes with the normal Jarvis workflow (`cd ~/jarvis && git add homeassistant && git commit`). Ignored by git: `secrets.yaml`, `.storage/`, databases, logs.
The old config repo's 9 commits are in the Jarvis log as ancestors of the move commit (`git log --oneline`; look for "Starting point: split config"). Their file paths are relative to the config folder, so `git log -- homeassistant/config` only shows the newer commits. A backup of the old repo is in `~/homeassistant/config-git-backup` (safe to delete once you're happy).
- `venv/` Home Assistant itself. Python 3.14 is in `python/` (standalone build via uv, because Homebrew has no 3.14 for macOS 12).
- `config/` all settings, and a git repo. Edit these files:
  - `configuration.yaml` main file, includes the others
  - `automations.yaml`, `scripts.yaml`, `scenes.yaml` (the UI editor also writes to these)
  - `packages/*.yaml` one file per topic (automations, scripts, helpers together)
  - `dashboards/home.yaml` the "Home" dashboard (YAML mode)
  - `secrets.yaml` passwords and keys (not in git). Use `!secret name` in other files.
  - `.storage/` Home Assistant's own database of devices, entities, integrations. NEVER edit by hand.
- `logs/home-assistant.log` the log. `logs/stdout.log` and `stderr.log` hold launchd's output.
- `ha.sh` helper: `states`, `call-service`, `reload`, `restart`, `check-config`, `logs` (token comes from `~/jarvis/.env`).
- `com.homeassistant.core.plist` the service file. Installed copy: `/Library/LaunchDaemons/com.homeassistant.core.plist` (runs as mahendra, KeepAlive).

## Making a change
1. Edit the files in `config/`.
2. `./ha.sh check-config` (must say "config OK").
3. `./ha.sh reload` for automations, scripts and scenes, or `./ha.sh restart` for anything else.
4. `./ha.sh logs 40` and confirm there are no new errors.
5. `cd ~/jarvis && git add homeassistant && git commit -m "what and why"` (then push).

## Roll back
`cd ~/jarvis && git log --oneline -- homeassistant/config`, then `git revert <commit>` (or `git checkout <commit> -- homeassistant/config/<file>`), then check-config and reload/restart.
Note: integrations, devices and their names live in `.storage/`, which git ignores, so rolling back git does not undo them.

## Service
- Restart: `./ha.sh restart`, or kill the process listening on 8123 and launchd starts it again.
- Stop/start for real needs sudo: `sudo launchctl bootout system/com.homeassistant.core` and `sudo launchctl bootstrap system /Library/LaunchDaemons/com.homeassistant.core.plist`.

## Zigbee dongle
Nabu Casa SkyConnect on `/dev/cu.usbserial-1460` (EZSP). The number comes from the USB port, so keep it in the same port.

## Shelly devices and the one that must never be switched on
| IP | Device | Channels |
|---|---|---|
| .155 | Shelly 2.5 | 1 Chandelier, 2 Chandelier Down Lights |
| .153 | Shelly 2.5 | 1 Side Garage, 2 Garage |
| .156 | Shelly 2.5 | 1 Khanda Light, **2 Frontyard Top Lights (LOCKED)** |
| .158 | Shelly 2.5 | 1 Side Lights, 2 Entrance Lights |
| .157 | Shelly 1PM | Driveway |
| .154 | Shelly 1PM | Frontyard Bottom Lights |
| .152 | Shelly 1PM | Butler's Pantry |

**Frontyard Top Lights (`switch.shellyswitch25_c8c9a37a653a_channel_2`) must never be turned on from Home Assistant: it trips the main circuit every time.**
Its entity is disabled in the entity registry, the dashboard shows it read-only, and `ha.sh call-service` refuses it.
Do not re-enable it, do not use it in automations or scenes. The wall switch is unaffected.

## Meross plugs (custom integration)
Installed by hand, not through HACS: `config/custom_components/meross_lan/`, **version 6.0.1** (from https://github.com/krahabb/meross_lan/releases/tag/v6.0.1). It is third-party code, so it is git-ignored and pinned here.
To reinstall or upgrade: download the release source zip, replace the folder, `./ha.sh check-config`, `./ha.sh restart`, and read the issue tracker first (6.0.0 broke many plugs; 6.0.1 fixed most; some models still drop offline for ~30 s every so often, issue #743).
The plugs are the four `C4:E7:AE:*` devices at 192.168.4.20, .25, .28, .78 (give them DHCP reservations in eero).

## ESPHome (Athom garage door opener)
The athom-garage-door-f99f26 opener is at 192.168.4.159 (MAC E0:98:06:F9:9F:26, ESPHome 2023.11.6, encrypted API on port 6053).
**Workaround in the venv (not in git):** on an Intel Mac, `aioesphomeapi` caps `cryptography<49` but Home Assistant 2026.11 pins `cryptography==50.0.2`, so Home Assistant's own installer refuses it. I installed `aioesphomeapi==46.25.0` and `bleak-esphome==4.0.0` by hand into the venv without touching cryptography (`uv pip install --no-deps`). `uv pip check` will warn about this mismatch; it is expected. If Home Assistant is upgraded and the esphome integration stops loading, redo this for the new `aioesphomeapi` version listed in `venv/.../homeassistant/components/esphome/manifest.json`.
**Never operate the garage door while testing.** Only add it; don't call cover services without asking.
