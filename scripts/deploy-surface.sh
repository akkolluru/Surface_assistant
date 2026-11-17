#!/usr/bin/env bash
set -euo pipefail

# Syncs the Surface Assistant repository from macOS to the Surface Pro 5 over SSH.
# Usage: ./scripts/deploy-surface.sh [--restart] [--dry-run] [-h|--help]

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

SURFACE_USER="${SURFACE_USER:-time-master}"
SURFACE_HOST="${SURFACE_HOST:-192.168.0.100}"
SURFACE_DIR="${SURFACE_DIR:-~/Surface_assistant}"

RESTART=false
SYNC_SYSTEM=false
DRY_RUN=false

usage() {
  cat <<'EOF'
Usage: ./scripts/deploy-surface.sh [OPTIONS]

Sync the repository from Mac to the Surface Pro 5 using rsync over SSH.

Options:
  --sync-system  Install Sway, Waybar, PipeWire, systemd user units, and helper scripts on Surface
  --restart      Run `systemctl --user restart surface-daemon.service` over SSH after sync
  --dry-run      Pass --dry-run to rsync and print (do not run) remote commands
  -h, --help     Show this help message and exit

Environment Variables:
  SURFACE_USER   SSH username (default: time-master)
  SURFACE_HOST   SSH host/IP  (default: 192.168.0.100)
  SURFACE_DIR    Remote path  (default: ~/Surface_assistant)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sync-system)
      SYNC_SYSTEM=true
      shift
      ;;
    --restart)
      RESTART=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: Unknown option '$1'" >&2
      usage >&2
      exit 1
      ;;
  esac
done

REMOTE_TARGET="${SURFACE_USER}@${SURFACE_HOST}"

# Normalize trailing slash (keep "/" intact)
if [[ "${SURFACE_DIR}" != "/" ]]; then
  SURFACE_DIR="${SURFACE_DIR%/}"
fi

# Resolve remote mkdir command and rsync destination (SSH rsync treats relative paths as $HOME-relative,
# avoiding literal "~" directory creation when rsync enables secluded-args).
if [[ "${SURFACE_DIR}" == "~" ]]; then
  REMOTE_MKDIR_CMD='mkdir -p "$HOME"'
  REMOTE_RSYNC_PATH='./'
elif [[ "${SURFACE_DIR}" == "~/"* ]]; then
  REL_DIR="${SURFACE_DIR#\~/}"
  printf -v ESCAPED_REL_DIR '%q' "${REL_DIR}"
  REMOTE_MKDIR_CMD="mkdir -p \"\$HOME\"/${ESCAPED_REL_DIR}"
  REMOTE_RSYNC_PATH="${ESCAPED_REL_DIR}/"
else
  printf -v ESCAPED_DIR '%q' "${SURFACE_DIR}"
  REMOTE_MKDIR_CMD="mkdir -p ${ESCAPED_DIR}"
  REMOTE_RSYNC_PATH="${ESCAPED_DIR}/"
fi

RSYNC_ARGS=(
  -avz
  --delete
  -e ssh
  --exclude='.git/'
  --exclude='.venv/'
  --exclude='venv/'
  --exclude='node_modules/'
  --exclude='.env'
  --exclude='config.yaml'
  --exclude='__pycache__/'
  --exclude='*.py[cod]'
  --exclude='.pytest_cache/'
  --exclude='.mypy_cache/'
  --exclude='.ruff_cache/'
  --exclude='.DS_Store'
  --exclude='homeassistant/data/'
  --exclude='homeassistant/.storage/'
  --exclude='homeassistant/home-assistant_v2.db*'
  --exclude='homeassistant/home-assistant.log*'
  --exclude='whisper-data/'
  --exclude='piper-data/'
  --exclude='openwakeword-data/'
)

if [[ ! -f "${REPO_ROOT}/frontend/dist/index.html" ]]; then
  RSYNC_ARGS+=(--exclude='frontend/dist/')
fi

if [[ "${DRY_RUN}" == "true" ]]; then
  RSYNC_ARGS+=(--dry-run)
fi

echo "Deploying ${REPO_ROOT} -> ${REMOTE_TARGET}:${SURFACE_DIR}"

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[dry-run] Would ensure remote directory: ssh ${REMOTE_TARGET} ${REMOTE_MKDIR_CMD}"
else
  ssh "${REMOTE_TARGET}" "${REMOTE_MKDIR_CMD}"
fi

rsync "${RSYNC_ARGS[@]}" "${REPO_ROOT}/" "${REMOTE_TARGET}:${REMOTE_RSYNC_PATH}"

if [[ "${SYNC_SYSTEM}" == "true" ]]; then
  if [[ "${SURFACE_DIR}" == "~" ]]; then
    REMOTE_REPO_EXPR='"$HOME"'
  elif [[ "${SURFACE_DIR}" == "~/"* ]]; then
    REMOTE_REPO_EXPR="\"\$HOME\"/${ESCAPED_REL_DIR}"
  else
    REMOTE_REPO_EXPR="${ESCAPED_DIR}"
  fi
  SYNC_CMD='set -euo pipefail
REPO_DIR='"${REMOTE_REPO_EXPR}"'
DATA_DIR="$HOME/.local/share/surface-assistant"
mkdir -p "$HOME/.config/sway" "$HOME/.config/waybar" "$HOME/.config/pipewire/pipewire.conf.d" "$HOME/.config/systemd/user" "$DATA_DIR/scripts" "$DATA_DIR/pipewire-rules"
cp "$REPO_DIR/system/sway/config" "$HOME/.config/sway/config"
cp "$REPO_DIR/system/waybar/config.jsonc" "$HOME/.config/waybar/config.jsonc"
cp "$REPO_DIR/system/waybar/style.css" "$HOME/.config/waybar/style.css"
cp "$REPO_DIR/system/pipewire-rules/50-surface-sinks.conf" "$HOME/.config/pipewire/pipewire.conf.d/50-surface-sinks.conf"
cp "$REPO_DIR/system/pipewire-rules/init-sinks.sh" "$DATA_DIR/pipewire-rules/init-sinks.sh"
cp "$REPO_DIR/system/scripts/"*.sh "$DATA_DIR/scripts/"
chmod +x "$DATA_DIR/pipewire-rules/init-sinks.sh" "$DATA_DIR/scripts/"*.sh
cp "$REPO_DIR/system/systemd/surface-daemon.service" "$HOME/.config/systemd/user/surface-daemon.service"
cp "$REPO_DIR/system/systemd/surface-wyoming-satellite.service" "$HOME/.config/systemd/user/surface-wyoming-satellite.service"
systemctl --user daemon-reload
if sudo -n true 2>/dev/null; then
  sudo mkdir -p /etc/iptsd.d
  sudo cp "$REPO_DIR/system/iptsd/90-touch-calibration.conf" /etc/iptsd.d/90-touch-calibration.conf
  sudo systemctl try-restart "iptsd@*" || true
else
  echo "Note: skipped /etc/iptsd.d/90-touch-calibration.conf (passwordless sudo unavailable); copy manually if changed."
fi
SWAYSOCK_FOUND="$(ls -t "/run/user/$(id -u)"/sway-ipc.*.sock 2>/dev/null | head -n 1 || true)"
if [[ -n "$SWAYSOCK_FOUND" ]]; then
  SWAYSOCK="$SWAYSOCK_FOUND" swaymsg reload >/dev/null 2>&1 || true
fi'
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "[dry-run] Would sync system configs/units on ${REMOTE_TARGET}"
  else
    echo "Syncing system configs and user units on ${REMOTE_TARGET}..."
    ssh "${REMOTE_TARGET}" "${SYNC_CMD}"
  fi
fi

if [[ "${RESTART}" == "true" ]]; then
  RESTART_CMD="systemctl --user restart surface-daemon.service"
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "[dry-run] Would run over SSH: ssh ${REMOTE_TARGET} '${RESTART_CMD}'"
  else
    echo "Restarting surface-daemon.service on ${REMOTE_TARGET}..."
    ssh "${REMOTE_TARGET}" "${RESTART_CMD}"
  fi
fi

echo "Deploy complete."
