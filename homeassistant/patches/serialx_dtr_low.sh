#!/bin/bash
# Makes serialx (the serial library ZHA/zigpy/universal-silabs-flasher use) open ports with DTR LOW instead of HIGH.
# Why: on this Mac (macOS 12, Intel) the Nabu Casa SkyConnect only answers when DTR=0 and RTS=1. With serialx's
# default of DTR=1 it stays silent (held in reset), so ZHA and the flasher could not talk to it.
# Re-run after upgrading Home Assistant or serialx (an upgrade restores the original file). Safe to run twice.
F="$HOME/homeassistant/venv/lib/python3.14/site-packages/serialx/common.py"
[ -f "$F" ] || { echo "not found: $F"; exit 1; }
if grep -q "dtr_on_open: PinState = PinState.LOW," "$F"; then echo "already patched"; exit 0; fi
cp "$F" "$HOME/homeassistant/serialx_common.py.orig"
sed -i '' 's/dtr_on_open: PinState = PinState.HIGH,/dtr_on_open: PinState = PinState.LOW,  # patched: SkyConnect on macOS needs DTR low/' "$F"
grep -n "dtr_on_open: PinState = PinState" "$F" | head -2
