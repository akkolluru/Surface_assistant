#!/usr/bin/env bash
set -euo pipefail

# Non-destructive verification script for Phase 2 SSH checkpoint on Surface Pro 5.

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This verification script must be run on Linux (Surface Pro 5)." >&2
  exit 1
fi

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '[PASS] %s\n' "$1"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf '[WARN] %s\n' "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '[FAIL] %s\n' "$1"
}

echo "==> Verifying Surface Pro 5 hardware, audio, and Phase 2 services..."

# 1. linux-surface kernel
kernel_rel="$(uname -r)"
if [[ "${kernel_rel}" == *-surface* ]]; then
  pass "linux-surface kernel active (${kernel_rel})"
else
  fail "Expected -surface kernel, found '${kernel_rel}'"
fi

# 2. Intel VA-API (vainfo)
if ! command -v vainfo >/dev/null 2>&1; then
  fail "vainfo command not found"
else
  if vainfo_out="$(vainfo --display drm 2>/dev/null || vainfo 2>/dev/null)"; then
    if grep -qiE "VAProfile|iHD|i965" <<< "${vainfo_out}"; then
      driver_line="$(grep -i "Driver version" <<< "${vainfo_out}" | head -n 1 || true)"
      pass "Intel VA-API available (${driver_line:-vainfo OK})"
    else
      warn "vainfo exited 0 but VAProfile/driver details were not detected"
    fi
  else
    fail "vainfo failed to query VA-API device"
  fi
fi

# 3. Ambient Light Sensor (IIO)
shopt -s nullglob
als_files=(/sys/bus/iio/devices/iio:device*/in_illuminance_raw)
shopt -u nullglob
if (( ${#als_files[@]} == 0 )); then
  fail "No ALS device found at /sys/bus/iio/devices/iio:device*/in_illuminance_raw"
else
  als_readable=false
  for als_file in "${als_files[@]}"; do
    if [[ -r "${als_file}" ]] && lux_raw="$(cat "${als_file}" 2>/dev/null)"; then
      pass "ALS readable (${als_file}: raw=${lux_raw})"
      als_readable=true
      break
    fi
  done
  if [[ "${als_readable}" != "true" ]]; then
    fail "ALS sysfs node exists (${als_files[0]}) but is not readable"
  fi
fi

# 4. Backlight write permission & video group
if id -nG | grep -qw "video"; then
  pass "User '${USER}' belongs to 'video' group"
else
  fail "User '${USER}' does NOT belong to 'video' group"
fi

backlight_file="/sys/class/backlight/intel_backlight/brightness"
if [[ -w "${backlight_file}" ]]; then
  pass "Backlight writable without sudo (${backlight_file})"
elif [[ -e "${backlight_file}" ]]; then
  fail "Backlight exists but is not writable by '${USER}' (${backlight_file})"
else
  fail "Backlight device missing (${backlight_file})"
fi

# 5. PipeWire virtual sinks
if ! command -v pactl >/dev/null 2>&1; then
  fail "pactl command not found"
elif ! sinks_out="$(pactl list short sinks 2>/dev/null)"; then
  fail "pactl list short sinks failed (PipeWire user session not running?)"
else
  for sink in alarm-sink tts-sink media-sink; do
    if grep -qw "${sink}" <<< "${sinks_out}"; then
      pass "PipeWire virtual sink active: ${sink}"
    else
      fail "PipeWire virtual sink missing: ${sink}"
    fi
  done
fi

# 6. systemd user services & daemon health
if systemctl --user is-active --quiet surface-daemon.service 2>/dev/null; then
  pass "surface-daemon.service is active"
else
  fail "surface-daemon.service is NOT active"
fi

if command -v curl >/dev/null 2>&1 && health_out="$(curl -fsS --max-time 3 http://127.0.0.1:8000/api/health 2>/dev/null)"; then
  pass "Daemon /api/health responded (${health_out})"
else
  fail "Daemon /api/health unreachable at http://127.0.0.1:8000/api/health"
fi

if systemctl --user is-active --quiet surface-wyoming-satellite.service 2>/dev/null; then
  pass "surface-wyoming-satellite.service is active"
else
  warn "surface-wyoming-satellite.service is not active (expected until Phase 3 voice stack is started)"
fi

# 7. Applications & Docker Compose
if command -v brave-browser >/dev/null 2>&1; then
  pass "brave-browser installed ($(command -v brave-browser))"
else
  fail "brave-browser not found in PATH"
fi

if stremio_bin="$(command -v stremio 2>/dev/null)"; then
  pass "stremio installed (${stremio_bin})"
  if [[ "${stremio_bin}" == *flatpak* ]] || grep -Iq "flatpak" "${stremio_bin}" 2>/dev/null; then
    if command -v flatpak >/dev/null 2>&1 && flatpak info com.stremio.Stremio >/dev/null 2>&1; then
      pass "Stremio Flatpak installed (com.stremio.Stremio)"
    else
      fail "stremio uses Flatpak, but 'flatpak info com.stremio.Stremio' failed"
    fi
  fi
else
  fail "stremio not found in PATH"
fi

if command -v docker >/dev/null 2>&1 && compose_ver="$(docker compose version 2>/dev/null)"; then
  pass "Docker Compose available (${compose_ver})"
else
  fail "docker compose is unavailable"
fi

# 8. Additional Phase 2 environment checks
if [[ -d "${HOME}/Surface_assistant" ]]; then
  pass "Repository path exists at ${HOME}/Surface_assistant"
else
  warn "Missing ${HOME}/Surface_assistant (expected by surface-daemon.service)"
fi

if loginctl show-user "${USER}" -p Linger 2>/dev/null | grep -q "Linger=yes"; then
  pass "systemd user linger enabled for '${USER}'"
else
  warn "systemd user linger is not enabled for '${USER}' (run: sudo loginctl enable-linger ${USER})"
fi

# 9. Sway Kiosk session, touchscreen & Brave window
kiosk_runner="${HOME}/.local/share/surface-assistant/scripts/run-kiosk-browser.sh"
if [[ -x "${kiosk_runner}" ]]; then
  pass "Kiosk browser launcher installed and executable (${kiosk_runner})"
elif [[ -e "${kiosk_runner}" ]]; then
  warn "Kiosk browser launcher exists at ${kiosk_runner} but is not executable (run ./scripts/deploy-surface.sh --sync-system)"
else
  warn "Kiosk browser launcher missing at ${kiosk_runner} (run ./scripts/deploy-surface.sh --sync-system)"
fi

shopt -s nullglob
sway_socks=("${XDG_RUNTIME_DIR}"/sway-ipc.*.sock)
shopt -u nullglob
if (( ${#sway_socks[@]} > 0 )) && SWAYSOCK="${sway_socks[0]}" swaymsg -t get_workspaces -r >/dev/null 2>&1; then
  pass "Sway compositor IPC active (${sway_socks[0]})"
  kiosk_tree="$(SWAYSOCK="${sway_socks[0]}" swaymsg -t get_tree -r 2>/dev/null || true)"
  if grep -q '"surface-kiosk"' <<< "${kiosk_tree}"; then
    if grep -q '"app_id": "surface-kiosk"' <<< "${kiosk_tree}"; then
      pass "Brave kiosk window (surface-kiosk) running on native Wayland (xdg_shell)"
    else
      warn "Brave kiosk window detected, but not on native Wayland app_id (XWayland fallback)"
    fi
  else
    warn "Sway is running, but 'surface-kiosk' window was not detected yet"
  fi

  inputs_json="$(SWAYSOCK="${sway_socks[0]}" swaymsg -t get_inputs -r 2>/dev/null || true)"
  if grep -q 'IPTSD_Virtual_Touchscreen' <<< "${inputs_json}"; then
    pass "IPTSD Virtual Touchscreen registered in Sway"
  else
    fail "IPTSD Virtual Touchscreen missing from Sway inputs"
  fi

  if pgrep -x waybar >/dev/null 2>&1; then
    pass "waybar overlay process is running"
  else
    warn "waybar is not running"
  fi
else
  warn "Sway compositor session is not active (GNOME/GDM may still be active until Sway autologin is applied)"
fi

if systemctl list-units 'iptsd@*.service' --state=active --no-legend 2>/dev/null | grep -q 'iptsd@'; then
  pass "iptsd templated touch service is active"
else
  warn "iptsd@*.service is not active"
fi

echo ""
printf 'Summary: %d passed, %d warned, %d failed\n' "${PASS_COUNT}" "${WARN_COUNT}" "${FAIL_COUNT}"

if (( FAIL_COUNT > 0 )); then
  exit 1
fi
