#!/usr/bin/env bash
set -euo pipefail

# Idempotent setup script for Microsoft Surface Pro 5 on Ubuntu 24.04 / 26.04 LTS
# (verified target: Ubuntu 26.04 LTS).
# Run as your normal user (NOT root) after cloning Surface_assistant.

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script must be run on Ubuntu 24.04 / 26.04 LTS on the Surface Pro 5." >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Run this script as your regular user (it will invoke sudo when needed)." >&2
  exit 1
fi

WITH_AUTOLOGIN=false
for arg in "$@"; do
  case "${arg}" in
    --with-autologin)
      WITH_AUTOLOGIN=true
      ;;
    -h|--help)
      echo "Usage: $0 [--with-autologin]"
      exit 0
      ;;
    *)
      echo "Unknown option: ${arg}" >&2
      echo "Usage: $0 [--with-autologin]" >&2
      exit 1
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_REPO_DIR="${HOME}/Surface_assistant"
DATA_DIR="${HOME}/.local/share/surface-assistant"

if [[ "${REPO_ROOT}" != "${EXPECTED_REPO_DIR}" ]]; then
  if [[ ! -e "${EXPECTED_REPO_DIR}" && ! -L "${EXPECTED_REPO_DIR}" ]]; then
    ln -s "${REPO_ROOT}" "${EXPECTED_REPO_DIR}"
    echo "Created symlink ${EXPECTED_REPO_DIR} -> ${REPO_ROOT} for surface-daemon.service."
  elif [[ -L "${EXPECTED_REPO_DIR}" ]]; then
    LINK_TARGET="$(readlink -f "${EXPECTED_REPO_DIR}" 2>/dev/null || true)"
    REPO_REAL="$(readlink -f "${REPO_ROOT}" 2>/dev/null || printf '%s' "${REPO_ROOT}")"
    if [[ "${LINK_TARGET}" != "${REPO_REAL}" ]]; then
      echo "Warning: ${EXPECTED_REPO_DIR} is a symlink to '${LINK_TARGET:-broken}', not '${REPO_ROOT}'." >&2
      echo "         surface-daemon.service expects WorkingDirectory=%h/Surface_assistant." >&2
    fi
  else
    echo "Warning: ${EXPECTED_REPO_DIR} already exists as a different path than ${REPO_ROOT}." >&2
    echo "         surface-daemon.service expects WorkingDirectory=%h/Surface_assistant." >&2
  fi
fi

echo "==> [1/8] Installing base packages, VA-API, Sway, PipeWire, KDE Connect, Flatpak, and Docker..."
sudo apt-get update
sudo apt-get install -y \
  curl gnupg ca-certificates git jq playerctl brightnessctl \
  python3-venv python3-pip nodejs npm \
  intel-media-va-driver vainfo \
  sway swayidle waybar swayosd xwayland foot \
  pipewire pipewire-pulse wireplumber pulseaudio-utils dbus-user-session \
  kdeconnect flatpak

if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get install -y docker.io
else
  echo "Docker already installed ($(docker --version 2>/dev/null || echo 'present')); skipping docker.io."
fi

if ! docker compose version >/dev/null 2>&1; then
  if ! sudo apt-get install -y docker-compose-v2; then
    sudo apt-get install -y docker-compose-plugin || \
      echo "Warning: Could not install docker-compose-v2 or docker-compose-plugin." >&2
  fi
else
  echo "Docker Compose already installed ($(docker compose version 2>/dev/null || echo 'present'))."
fi

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

echo "==> [3b/8] Installing/verifying Stremio (Flathub + /usr/local/bin/stremio)..."
if ! command -v stremio >/dev/null 2>&1; then
  if ! command -v flatpak >/dev/null 2>&1; then
    sudo apt-get install -y flatpak
  fi
  if ! sudo flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo; then
    echo "Warning: Could not add Flathub remote; skipping Stremio installation." >&2
  elif ! flatpak info com.stremio.Stremio >/dev/null 2>&1 && ! sudo flatpak install -y flathub com.stremio.Stremio; then
    echo "Warning: Failed to install com.stremio.Stremio from Flathub (offline or repo unavailable?)." >&2
  fi

  if flatpak info com.stremio.Stremio >/dev/null 2>&1; then
    sudo tee /usr/local/bin/stremio >/dev/null <<'EOF'
#!/usr/bin/env bash
exec flatpak run com.stremio.Stremio "$@"
EOF
    sudo chmod +x /usr/local/bin/stremio
    echo "Created /usr/local/bin/stremio wrapper for com.stremio.Stremio."
  else
    echo "Warning: Stremio Flatpak is not installed; /usr/local/bin/stremio was not created." >&2
  fi
else
  echo "Stremio already available at $(command -v stremio)."
fi

echo "==> [4/8] Configuring groups (docker, video) and backlight udev rule..."
if getent group docker >/dev/null 2>&1; then
  sudo usermod -aG docker,video "${USER}"
else
  echo "Warning: 'docker' group not found; adding ${USER} to 'video' group only." >&2
  sudo usermod -aG video "${USER}"
fi
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

sudo mkdir -p /etc/iptsd.d
sudo cp "${REPO_ROOT}/system/iptsd/90-touch-calibration.conf" /etc/iptsd.d/90-touch-calibration.conf
sudo systemctl try-restart 'iptsd@*' || true

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

echo "==> [7/8] Installing systemd user services and enabling linger..."
cp "${REPO_ROOT}/system/systemd/surface-daemon.service" "${HOME}/.config/systemd/user/surface-daemon.service"
cp "${REPO_ROOT}/system/systemd/surface-wyoming-satellite.service" "${HOME}/.config/systemd/user/surface-wyoming-satellite.service"
sudo loginctl enable-linger "${USER}"
systemctl --user daemon-reload
systemctl --user enable surface-daemon.service surface-wyoming-satellite.service

echo "==> [8/8] Copying example configs if missing..."
[[ -f "${REPO_ROOT}/.env" ]] || cp "${REPO_ROOT}/.env.example" "${REPO_ROOT}/.env"
[[ -f "${REPO_ROOT}/config.yaml" ]] || cp "${REPO_ROOT}/config.example.yaml" "${REPO_ROOT}/config.yaml"

if [[ "${WITH_AUTOLOGIN}" == "true" ]]; then
  echo "==> Configuring TTY1 Sway kiosk autologin..."
  bash "${REPO_ROOT}/system/scripts/setup-kiosk-autologin.sh"
fi

echo ""
echo "Setup complete! Next steps:"
echo "  1. Reboot into the linux-surface kernel (sudo reboot)."
echo "  2. Pair your Android devices in KDE Connect and set ANIME_PORTAL_URL in .env."
echo "  3. Start the Docker voice/HA stack: docker compose up -d"
if [[ "${WITH_AUTOLOGIN}" != "true" ]]; then
  echo "  4. Optional: configure TTY1 Sway kiosk autologin: bash system/scripts/setup-kiosk-autologin.sh"
  echo "  5. Verify Surface hardware & services: bash system/scripts/verify-surface.sh"
else
  echo "  4. Verify Surface hardware & services after reboot: bash system/scripts/verify-surface.sh"
fi
