#!/usr/bin/env bash
set -euo pipefail

# Triggered by the floating Waybar "Home" pill (or touch gesture) to return to Workspace 1.
if curl -fsS -X POST "http://127.0.0.1:8000/api/media/home" >/dev/null 2>&1; then
  exit 0
fi

# Direct fallback if daemon is temporarily unavailable.
playerctl -a pause >/dev/null 2>&1 || true
swaymsg 'workspace "1:hub"' >/dev/null 2>&1 || true
