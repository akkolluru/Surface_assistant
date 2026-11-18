#!/usr/bin/env bash
set -euo pipefail

# Streams Sway workspace and window state to Waybar without polling so the bottom-right
# pill appears on Workspace 2 ("Home") or when the kiosk hub is missing ("Open Hub").

trap 'pkill -P $$ 2>/dev/null || true' EXIT TERM INT

emit_state() {
  local ws workspaces_json tree_json tree_stats has_kiosk media_windows

  workspaces_json="$(swaymsg -t get_workspaces -r 2>/dev/null || echo '[]')"
  ws="$(jq -r '(.[] | select(.focused == true) | .name) // empty' <<< "${workspaces_json}" 2>/dev/null | head -n 1 || true)"
  ws="${ws:-1:hub}"

  has_kiosk="true"
  media_windows="0"
  if tree_json="$(swaymsg -t get_tree -r 2>/dev/null)" && [[ -n "${tree_json}" ]]; then
    tree_stats="$(jq -r '
      ([.. | objects | select((.app_id? == "surface-kiosk") or (.window_properties?.class? == "surface-kiosk"))] | length > 0 | tostring) + " " +
      ([.. | objects | select(.type? == "workspace" and .name? == "2:media") | (.nodes[]?, .floating_nodes[]?) | recurse(.nodes[]?, .floating_nodes[]?) | select(((.nodes? // []) | length) == 0 and ((.floating_nodes? // []) | length) == 0)] | length | tostring)
    ' <<< "${tree_json}" 2>/dev/null || echo 'true 0')"
    read -r has_kiosk media_windows <<< "${tree_stats}"
  fi
  : "${media_windows:=0}"

  if [[ "${ws}" == "2:media" ]]; then
    printf '{"text":"⌂ Home","class":"visible","tooltip":"Return to Ambient Hub"}\n' || true
  elif [[ "${has_kiosk}" != "true" ]]; then
    printf '{"text":"↻ Open Hub","class":"recover","tooltip":"Reopen Ambient Hub"}\n' || true
  else
    printf '{"text":"","class":"hidden"}\n' || true
  fi
}

emit_state

swaymsg -t subscribe -m '["workspace","window"]' 2>/dev/null | while IFS= read -r _; do
  emit_state
done || true
