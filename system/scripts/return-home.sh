#!/usr/bin/env bash
set -euo pipefail

# Triggered by the floating Waybar "Home" / "Open Hub" pill (or touch gesture)
# to return to Workspace 1 or relaunch the kiosk hub if Brave closed.

RELAUNCH=false
for arg in "$@"; do
  case "${arg}" in
    --relaunch)
      RELAUNCH=true
      ;;
    -h|--help)
      echo "Usage: $0 [--relaunch]"
      exit 0
      ;;
    *)
      echo "Unknown option: ${arg}" >&2
      echo "Usage: $0 [--relaunch]" >&2
      exit 1
      ;;
  esac
done

has_kiosk="true"
if [[ "${RELAUNCH}" != "true" ]]; then
  if tree_json="$(swaymsg -t get_tree -r 2>/dev/null)" && [[ -n "${tree_json}" ]]; then
    has_kiosk="$(jq -r '[.. | objects | select((.app_id? == "surface-kiosk") or (.window_properties?.class? == "surface-kiosk"))] | length > 0' <<< "${tree_json}" 2>/dev/null || echo 'true')"
  fi
fi

if [[ "${RELAUNCH}" == "true" || "${has_kiosk}" != "true" ]]; then
  swaymsg 'workspace "1:hub"' >/dev/null 2>&1 || true
  kiosk_runner="${HOME}/.local/share/surface-assistant/scripts/run-kiosk-browser.sh"
  if [[ ! -x "${kiosk_runner}" ]]; then
    local_runner="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run-kiosk-browser.sh"
    if [[ -x "${local_runner}" ]]; then
      kiosk_runner="${local_runner}"
    fi
  fi
  if [[ -x "${kiosk_runner}" ]]; then
    nohup "${kiosk_runner}" </dev/null >/dev/null 2>&1 &
    disown "$!" 2>/dev/null || true
  else
    echo "Warning: kiosk launcher not found or not executable: ${kiosk_runner}" >&2
  fi
  exit 0
fi

if curl -fsS -X POST "http://127.0.0.1:8000/api/media/home" >/dev/null 2>&1; then
  exit 0
fi

# Direct fallback if daemon is temporarily unavailable.
playerctl -a pause >/dev/null 2>&1 || true
swaymsg 'workspace "1:hub"' >/dev/null 2>&1 || true
