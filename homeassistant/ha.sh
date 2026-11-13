#!/bin/bash
# Small helper for Home Assistant. Reads HA_URL and HA_TOKEN from ~/jarvis/.env (never prints the token).
#
#   ./ha.sh states [text]                       list entities (optionally only those containing "text")
#   ./ha.sh call-service domain service [json]  e.g. ./ha.sh call-service switch turn_on '{"entity_id":"switch.x"}'
#   ./ha.sh reload [automation|script|scene|core|all]   reload YAML without a restart
#   ./ha.sh restart                             restart Home Assistant (launchd brings it back)
#   ./ha.sh check-config                        validate the config files (run before reload/restart)
#   ./ha.sh logs [lines]                        tail the Home Assistant log

HA_DIR="$HOME/homeassistant"
ENV_FILE="$HOME/jarvis/.env"

# Pull just the two values we need out of the env file.
HA_URL=$(grep '^HA_URL=' "$ENV_FILE" | cut -d= -f2-)
HA_TOKEN=$(grep '^HA_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
HA_URL=${HA_URL:-http://127.0.0.1:8123}

api() { # api METHOD PATH [json body]
  curl -sS -X "$1" -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" \
    ${3:+-d "$3"} "$HA_URL$2"
}

case "$1" in
  states)
    api GET /api/states | python3 -c '
import sys, json
needle = sys.argv[1].lower() if len(sys.argv) > 1 else ""
for s in sorted(json.load(sys.stdin), key=lambda s: s["entity_id"]):
    if needle in s["entity_id"].lower() or needle in str(s["attributes"].get("friendly_name", "")).lower():
        print(s["entity_id"], "=", s["state"])
' "$2"
    ;;
  call-service)
    body=${4:-"{}"}
    # SAFETY: this relay (Frontyard Top Lights, Shelly 156 channel 2) trips the main circuit if switched on. Never call it.
    case "$body" in *shellyswitch25_c8c9a37a653a_channel_2*) echo "refused: that relay trips the main circuit (see README)"; exit 1 ;; esac
    api POST "/api/services/$2/$3" "$body"
    echo
    ;;
  reload)
    case "${2:-all}" in
      automation|script|scene|core) api POST "/api/services/$2/reload" "{}" ;;
      all)
        for d in automation script scene; do api POST "/api/services/$d/reload" "{}"; done
        api POST /api/services/homeassistant/reload_core_config "{}" ;;
      *) echo "reload: automation | script | scene | core | all"; exit 1 ;;
    esac
    echo
    ;;
  restart)
    api POST /api/services/homeassistant/restart "{}"
    echo "restart requested; it takes about a minute. Check with: ./ha.sh logs 30"
    ;;
  check-config)
    "$HA_DIR/venv/bin/hass" --script check_config -c "$HA_DIR/config"
    code=$?
    [ $code -eq 0 ] && echo "config OK" || echo "config has errors (exit $code)"
    exit $code
    ;;
  logs)
    tail -n "${2:-50}" "$HA_DIR/logs/home-assistant.log"
    ;;
  *)
    sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
