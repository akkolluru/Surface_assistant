#!/usr/bin/env bash
set -euo pipefail

# Handles physical Surface Pro 5 volume rocker keys across Sway workspaces:
# - Workspace 1 (1:hub): adjusts media-sink via daemon and opens React 3-channel VolumeOSD
# - Workspace 2 (2:media): adjusts media-sink and displays lightweight swayosd overlay

ACTION="${1:-}"
if [[ "${ACTION}" != "up" && "${ACTION}" != "down" && "${ACTION}" != "mute" ]]; then
  echo "Usage: $0 {up|down|mute}" >&2
  exit 1
fi

ACTIVE_WS="$(swaymsg -t get_workspaces -r | jq -r '.[] | select(.focused == true) | .name' 2>/dev/null || echo '1:hub')"

if [[ "${ACTIVE_WS}" == "1:hub" ]]; then
  curl -fsS -X POST "http://127.0.0.1:8000/api/audio/rocker" \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"${ACTION}\"}" >/dev/null && exit 0
fi

# Fallback (or Workspace 2 fullscreen video): adjust media-sink directly + show swayosd.
SINK_TARGET="media-sink"
if ! pactl list short sinks 2>/dev/null | grep -q "${SINK_TARGET}"; then
  SINK_TARGET="@DEFAULT_SINK@"
fi

case "${ACTION}" in
  up)
    pactl set-sink-mute "${SINK_TARGET}" 0
    pactl set-sink-volume "${SINK_TARGET}" +5%
    if command -v swayosd-client >/dev/null 2>&1; then
      swayosd-client --output-volume raise >/dev/null 2>&1 || true
    fi
    ;;
  down)
    pactl set-sink-volume "${SINK_TARGET}" -5%
    if command -v swayosd-client >/dev/null 2>&1; then
      swayosd-client --output-volume lower >/dev/null 2>&1 || true
    fi
    ;;
  mute)
    pactl set-sink-mute "${SINK_TARGET}" toggle
    if command -v swayosd-client >/dev/null 2>&1; then
      swayosd-client --output-volume mute-toggle >/dev/null 2>&1 || true
    fi
    ;;
esac
