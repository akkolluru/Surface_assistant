#!/usr/bin/env bash
set -euo pipefail

# Idempotent setup script for Microsoft Surface Pro 5 on Ubuntu 24.04 LTS.
# Run as your normal user (NOT root) after cloning Surface_assistant.

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script must be run on Ubuntu 24.04 LTS on the Surface Pro 5." >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Run this script as your regular user (it will invoke sudo when needed)." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${HOME}/.local/share/surface-assistant"

echo "==> [1/8] Installing base packages, VA-API, Sway, PipeWire, and KDE Connect..."
sudo apt-get update
sudo apt-get install -y \
  curl gnupg ca-certificates git jq playerctl brightnessctl \
  python3-venv python3-pip nodejs npm \
  intel-media-va-driver vainfo \
  sway swayidle waybar swayosd xwayland foot \
  pipewire pipewire-pulse wireplumber pulseaudio-utils \
  kdeconnect docker.io docker-compose-v2

echo "==> [2/8] Installing linux-surface kernel and touch daemon (iptsd)..."
if [[ ! -f /etc/apt/sources.list.d/linux-surface.list ]]; then
  curl -fsSL https://raw.githubusercontent.com/linux-surface/linux-surface/master/pkg/keys/surface.asc \
    | gpg --dearmor | sudo tee /etc/apt/trusted.gpg.d/linux-surface.gpg >/dev/null
  echo "deb [arch=amd64] https://pkg.surfacelinux.com/debian release main" \
    | sudo tee /etc/apt/sources.list.d/linux-surface.list >/dev/null
  sudo apt-get update
fi
sudo apt-get install -y linux-image-surface linux-headers-surface iptsd libwacom-surface
if mokutil --sb-state 2>/dev/null | grep -qi "enabled"; then
  echo "Secure Boot is enabled; installing linux-surface MOK package (follow prompt if shown)..."
  sudo apt-get install -y linux-surface-secureboot-mok || true
fi

echo "==> [3/8] Installing Brave Browser (.deb)..."
if ! command -v brave-browser >/dev/null 2>&1; then
  sudo curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg \
    https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg] https://brave-browser-apt-release.s3.brave.com/ stable main" \
    | sudo tee /etc/apt/sources.list.d/brave-browser-release.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y brave-browser
fi

echo "==> [4/8] Configuring groups (docker, video) and backlight udev rule..."
sudo usermod -aG docker,video "${USER}"
sudo cp "${REPO_ROOT}/system/udev/90-surface-backlight.rules" /etc/udev/rules.d/90-surface-backlight.rules
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=backlight || true

echo "==> [5/8] Installing Sway, Waybar, PipeWire, and helper script configs..."
mkdir -p \
  "${HOME}/.config/sway" \
  "${HOME}/.config/waybar" \
  "${HOME}/.config/pipewire/pipewire.conf.d" \
  "${HOME}/.config/systemd/user" \
  "${DATA_DIR}/scripts" \
  "${DATA_DIR}/pipewire-rules" \
  "${HOME}/wallpapers/static" \
  "${HOME}/wallpapers/loops"

cp "${REPO_ROOT}/system/sway/config" "${HOME}/.config/sway/config"
cp "${REPO_ROOT}/system/waybar/config.jsonc" "${HOME}/.config/waybar/config.jsonc"
cp "${REPO_ROOT}/system/waybar/style.css" "${HOME}/.config/waybar/style.css"
cp "${REPO_ROOT}/system/pipewire-rules/50-surface-sinks.conf" "${HOME}/.config/pipewire/pipewire.conf.d/50-surface-sinks.conf"
cp "${REPO_ROOT}/system/pipewire-rules/init-sinks.sh" "${DATA_DIR}/pipewire-rules/init-sinks.sh"
cp "${REPO_ROOT}/system/scripts/"*.sh "${DATA_DIR}/scripts/"
chmod +x "${DATA_DIR}/pipewire-rules/init-sinks.sh" "${DATA_DIR}/scripts/"*.sh

echo "==> [6/8] Creating Python virtual environments (daemon + wyoming-satellite)..."
if [[ ! -d "${DATA_DIR}/daemon-venv" ]]; then
  python3 -m venv "${DATA_DIR}/daemon-venv"
fi
if [[ -f "${REPO_ROOT}/daemon/requirements.txt" ]]; then
  "${DATA_DIR}/daemon-venv/bin/pip" install --upgrade pip
  "${DATA_DIR}/daemon-venv/bin/pip" install -r "${REPO_ROOT}/daemon/requirements.txt"
fi

if [[ ! -d "${DATA_DIR}/wyoming-venv" ]]; then
  python3 -m venv "${DATA_DIR}/wyoming-venv"
  "${DATA_DIR}/wyoming-venv/bin/pip" install --upgrade pip wyoming-satellite
fi

echo "==> [6b/8] Building production Kiosk frontend bundle..."
if [[ -f "${REPO_ROOT}/frontend/package.json" ]]; then
  (cd "${REPO_ROOT}/frontend" && npm ci && npm run build)
fi

echo "==> [7/8] Installing systemd user services..."
cp "${REPO_ROOT}/system/systemd/surface-daemon.service" "${HOME}/.config/systemd/user/surface-daemon.service"
cp "${REPO_ROOT}/system/systemd/surface-wyoming-satellite.service" "${HOME}/.config/systemd/user/surface-wyoming-satellite.service"
systemctl --user daemon-reload
systemctl --user enable surface-daemon.service surface-wyoming-satellite.service

echo "==> [8/8] Copying example configs if missing..."
[[ -f "${REPO_ROOT}/.env" ]] || cp "${REPO_ROOT}/.env.example" "${REPO_ROOT}/.env"
[[ -f "${REPO_ROOT}/config.yaml" ]] || cp "${REPO_ROOT}/config.example.yaml" "${REPO_ROOT}/config.yaml"

echo ""
echo "Setup complete! Next steps:"
echo "  1. Reboot into the linux-surface kernel (sudo reboot)."
echo "  2. Pair your Android devices in KDE Connect and set ANIME_PORTAL_URL in .env."
echo "  3. Start the Docker voice/HA stack: docker compose up -d"
echo "  4. Launch Sway from TTY (or configure greetd/getty autologin to run 'sway')."
