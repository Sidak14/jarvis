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

## Zigbee dongle (ZHA)
Nabu Casa SkyConnect / "Home Assistant Connect ZBT-1" on `/dev/cu.usbserial-1420` (it was `-1460` in another port; the number comes from the USB port, so keep it in the same port). ZHA radio: EZSP, 115200 baud, no flow control. Firmware: Nabu Casa Zigbee NCP **7.5.1.0** (`skyconnect_zigbee_ncp_7.5.1.0.gbl` from https://github.com/NabuCasa/silabs-firmware-builder/releases/tag/v2026.02.23), flashed on 13 Nov 2026 from a Windows PC with `universal-silabs-flasher`, because the dongle would not answer on this Mac.
ZHA formed a new Zigbee network ("recommended" setup). **No Zigbee devices are paired**; pair only when asked.
**Mac-specific fix (not in git, re-apply after upgrades):** on this Mac the dongle only answers when DTR is low and RTS is high; serialx opens ports with DTR high by default, which keeps it silent. `homeassistant/patches/serialx_dtr_low.sh` changes serialx's default to DTR low (backs up the original to `~/homeassistant/serialx_common.py.orig`). Run it again after upgrading Home Assistant or serialx (an upgrade restores the original file), then restart Home Assistant. Symptom if forgotten: ZHA "cannot connect", flasher probe finds nothing.

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
Added through the Meross account login (profile). Plugs in Home Assistant: Water Fountain (MSS315, .20), Courtyard Lights (MSS310, .25; was "Smart Plug"), Smart Plug backyard 1 (MSS315, .28). The fourth, Smart Plug backyard 2 (MSS315, .78, C4:E7:AE:1D:CF:A0), was offline at first and was added later.
Entity ids were renamed after the devices (`switch.water_fountain`, `sensor.water_fountain_power`, ...). `light.*_dnd` is the plug's status LED, not a lamp.

## ESPHome (Athom garage door opener)
Athom garage door opener at 192.168.4.159 (MAC E0:98:06:F9:9F:26). Running **Athom's stock firmware 2026.9.1 (v1.2.7)** from https://github.com/athom-tech/athom-configs/releases/tag/esphome-2026.9.1, which has **no API encryption key**, so Home Assistant adds it without one.
How it got there (13 Nov 2026): the opener (ESP8285, ~1 MB flash) came with an old encrypted firmware (ESPHome 2023.11.6) and a key nobody had. A direct OTA of Athom's image failed with "Not Enough Space", so I pushed a small stepping-stone ESPHome build first (`~/homeassistant/esphome/minimal/minimal.yaml`, 337 KB, Wi-Fi + OTA only), re-joined Wi-Fi through the device's setup hotspot on a phone, then uploaded Athom's image with `esphome upload --file`. Wi-Fi had to be re-entered through the hotspot after each step.
ESPHome for that lives in its own venv, `~/homeassistant/esphome/venv` (ESPHome 2026.10.2, Python 3.13, toolchain in `~/homeassistant/esphome/platformio`), not in the Home Assistant venv. Not in git.
**Never operate the garage door unless asked.** The dashboard shows it read-only. In Home Assistant the Factory Reset and Safe Mode buttons are disabled on purpose (don't re-enable); the relay and contact entities are disabled by default.
If the opener loses Wi-Fi it opens a hotspot named `athom-garage-door-f99f26` (no password) with a setup page at 192.168.4.1.

**Home Assistant venv note:** `aioesphomeapi==46.25.0` and `bleak-esphome==4.0.0` were installed by hand into the Home Assistant venv without touching cryptography (on an Intel Mac `aioesphomeapi` caps `cryptography<49` but Home Assistant pins 50.0.2). `uv pip check` warns about that; it is expected. If an upgrade stops the esphome integration loading, redo it for the version in `homeassistant/components/esphome/manifest.json`.
