#!/usr/bin/env bash
set -euo pipefail

# Keeps Waybar running across crashes while allowing `swaymsg reload` (`exec_always`)
# to cleanly replace an older instance without Sway `$` variable mangling.

RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
mkdir -p "${RUNTIME_DIR}"
PIDFILE="${RUNTIME_DIR}/surface-waybar.pid"

RESPAWN_DELAY="${RESPAWN_DELAY:-1}"
WAYBAR_CONFIG="${WAYBAR_CONFIG:-${HOME}/.config/waybar/config.jsonc}"
WAYBAR_STYLE="${WAYBAR_STYLE:-${HOME}/.config/waybar/style.css}"

CHILD_PID=""
STOP_REQUESTED=0

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

old_pid="$(cat "${PIDFILE}" 2>/dev/null || true)"
printf '%s\n' "$$" > "${PIDFILE}"

if [[ "${old_pid}" =~ ^[0-9]+$ ]] && [[ "${old_pid}" != "$$" ]]; then
  kill "${old_pid}" 2>/dev/null || true
fi

pkill -f "[w]aybar-home-state.sh" 2>/dev/null || true
pkill -f "[s]waymsg -t subscribe" 2>/dev/null || true
pkill -x waybar 2>/dev/null || true

cleanup() {
  STOP_REQUESTED=1
  if [[ -n "${CHILD_PID}" ]] && kill -0 "${CHILD_PID}" 2>/dev/null; then
    kill "${CHILD_PID}" 2>/dev/null || true
    wait "${CHILD_PID}" 2>/dev/null || true
  fi
  if [[ "$(cat "${PIDFILE}" 2>/dev/null || true)" == "$$" ]]; then
    rm -f "${PIDFILE}"
  fi
}

handle_signal() {
  cleanup
  exit 0
}

trap cleanup EXIT
trap handle_signal TERM INT

while (( ! STOP_REQUESTED )) && [[ "$(cat "${PIDFILE}" 2>/dev/null || true)" == "$$" ]] && sway_is_alive; do
  waybar -c "${WAYBAR_CONFIG}" -s "${WAYBAR_STYLE}" &
  CHILD_PID=$!
  wait "${CHILD_PID}" || true
  CHILD_PID=""

  if (( STOP_REQUESTED )) || [[ "$(cat "${PIDFILE}" 2>/dev/null || true)" != "$$" ]] || ! sway_is_alive; then
    break
  fi
  sleep "${RESPAWN_DELAY}"
done
