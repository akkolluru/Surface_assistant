#!/usr/bin/env bash
set -euo pipefail

# Wait briefly for PipeWire virtual sinks to register on login.
for _ in $(seq 1 20); do
  if pactl list short sinks 2>/dev/null | grep -q "media-sink"; then
    break
  fi
  sleep 0.5
done

if ! pactl list short sinks 2>/dev/null | grep -q "media-sink"; then
  echo "Warning: PipeWire virtual sinks not found; skipping default initialization." >&2
  exit 0
fi

# Make media-sink the default system sink so Brave/Stremio automatically route there.
pactl set-default-sink media-sink

# Apply initial default stream levels (all independently adjustable by the user).
pactl set-sink-volume alarm-sink 100%
pactl set-sink-volume tts-sink 50%
pactl set-sink-volume media-sink 60%

pactl set-sink-mute alarm-sink 0
pactl set-sink-mute tts-sink 0
pactl set-sink-mute media-sink 0
