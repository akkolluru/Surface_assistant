#!/usr/bin/env bash
set -euo pipefail

# Streams Sway workspace state to Waybar without polling so the floating "Home"
# pill only appears when a fullscreen video app is active on Workspace 2.

trap 'pkill -P $$ 2>/dev/null || true' EXIT TERM INT

emit_state() {
  local ws
  ws="$(swaymsg -t get_workspaces -r 2>/dev/null | jq -r '.[] | select(.focused == true) | .name' || echo '1:hub')"
  if [[ "${ws}" == "2:media" ]]; then
    printf '{"text":"⌂ Home","class":"visible","tooltip":"Return to Ambient Hub"}\n' || true
  else
    printf '{"text":"","class":"hidden"}\n' || true
  fi
}

emit_state

swaymsg -t subscribe -m '["workspace"]' 2>/dev/null | while IFS= read -r _; do
  emit_state
done || true
