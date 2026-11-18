#!/usr/bin/env bash
set -euo pipefail

# Keeps the Brave Ambient Hub kiosk alive for the lifetime of the Sway session,
# preventing duplicate respawn loops via flock and clearing stale crash state.

RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
mkdir -p "${RUNTIME_DIR}"

LOCK_FILE="${RUNTIME_DIR}/surface-kiosk-browser.lock"
exec 9>"${LOCK_FILE}"
flock -n 9 || exit 0

KIOSK_PROFILE="${HOME}/.local/share/surface-assistant/kiosk-profile"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8000/api/health}"
HEALTH_MAX_ATTEMPTS="${HEALTH_MAX_ATTEMPTS:-30}"
HEALTH_POLL_INTERVAL="${HEALTH_POLL_INTERVAL:-0.5}"
HEALTH_RETRY_DELAY="${HEALTH_RETRY_DELAY:-2}"
RESPAWN_DELAY="${RESPAWN_DELAY:-1}"

CHILD_PID=""
STOP_REQUESTED=0

cleanup() {
  STOP_REQUESTED=1
  if [[ -n "${CHILD_PID}" ]] && kill -0 "${CHILD_PID}" 2>/dev/null; then
    kill "${CHILD_PID}" 2>/dev/null || true
    wait "${CHILD_PID}" 2>/dev/null || true
  fi
}

handle_signal() {
  cleanup
  exit 0
}

trap cleanup EXIT
trap handle_signal TERM INT

sway_is_alive() {
  if [[ -n "${SWAYSOCK:-}" ]] && swaymsg -t get_version >/dev/null 2>&1; then
    return 0
  fi
  if swaymsg -t get_version >/dev/null 2>&1; then
    return 0
  fi
  local sock
  shopt -s nullglob
  for sock in "${RUNTIME_DIR}"/sway-ipc.*.sock; do
    if SWAYSOCK="${sock}" swaymsg -t get_version >/dev/null 2>&1; then
      export SWAYSOCK="${sock}"
      shopt -u nullglob
      return 0
    fi
  done
  shopt -u nullglob
  return 1
}

if [[ -z "${WAYLAND_DISPLAY:-}" ]]; then
  shopt -s nullglob
  for wsock in "${RUNTIME_DIR}"/wayland-[0-9]*; do
    [[ "${wsock}" == *.lock ]] && continue
    if [[ -S "${wsock}" ]]; then
      export WAYLAND_DISPLAY="${wsock##*/}"
      break
    fi
  done
  shopt -u nullglob
fi

while sway_is_alive; do
  if (( STOP_REQUESTED )); then
    break
  fi

  health_ok=false
  for _ in $(seq 1 "${HEALTH_MAX_ATTEMPTS}"); do
    if (( STOP_REQUESTED )); then
      exit 0
    fi
    if curl -fsS --max-time 2 "${HEALTH_URL}" >/dev/null 2>&1; then
      health_ok=true
      break
    fi
    if ! sway_is_alive; then
      exit 0
    fi
    sleep "${HEALTH_POLL_INTERVAL}"
  done

  if [[ "${health_ok}" != "true" ]]; then
    echo "[run-kiosk-browser] Daemon ${HEALTH_URL} unreachable; retrying in ${HEALTH_RETRY_DELAY}s..." >&2
    sleep "${HEALTH_RETRY_DELAY}"
    continue
  fi

  mkdir -p "${KIOSK_PROFILE}/Default"

  if ! pgrep -f "[b]rave.*kiosk-profile" >/dev/null 2>&1; then
    rm -rf "${KIOSK_PROFILE}/Default/Sessions"
    rm -f "${KIOSK_PROFILE}"/Singleton*
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 - "${KIOSK_PROFILE}/Default/Preferences" <<'PY' || echo "[run-kiosk-browser] Warning: failed to update Brave Preferences" >&2
import json
import os
import sys
from pathlib import Path

prefs_path = Path(sys.argv[1])
data = {}
if prefs_path.is_file():
    try:
        loaded = json.loads(prefs_path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            data = loaded
    except (OSError, json.JSONDecodeError):
        data = {}

profile = data.get("profile")
if not isinstance(profile, dict):
    profile = {}
    data["profile"] = profile

profile["exit_type"] = "Normal"
profile["exited_cleanly"] = True

content_settings = profile.get("default_content_setting_values")
if not isinstance(content_settings, dict):
    content_settings = {}
    profile["default_content_setting_values"] = content_settings

content_settings["popups"] = 2

tmp_path = prefs_path.with_name(f"{prefs_path.name}.tmp.{os.getpid()}")
tmp_path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
os.replace(tmp_path, prefs_path)
PY
  fi

  if (( STOP_REQUESTED )) || ! sway_is_alive; then
    break
  fi

  rc=0
  brave-browser \
    --user-data-dir="${KIOSK_PROFILE}" \
    --kiosk http://127.0.0.1:8000 \
    --class=surface-kiosk \
    --ozone-platform=wayland \
    --touch-events=enabled \
    --password-store=basic \
    --disable-features=Vulkan \
    --enable-features=VaapiVideoDecodeLinuxGL,VaapiIgnoreDriverChecks \
    --overscroll-history-navigation=0 \
    --disable-pinch \
    --no-first-run \
    --noerrdialogs \
    --disable-session-crashed-bubble 9>&- &
  CHILD_PID=$!
  wait "${CHILD_PID}" || rc=$?
  CHILD_PID=""

  if (( STOP_REQUESTED )) || ! sway_is_alive; then
    break
  fi

  echo "[run-kiosk-browser] brave-browser exited with status ${rc}; respawning in ${RESPAWN_DELAY}s..." >&2
  sleep "${RESPAWN_DELAY}"
done
