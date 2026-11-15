#!/usr/bin/env bash
set -euo pipefail

# Idempotently configure (or remove) TTY1 Sway kiosk autologin for the current user
# on Ubuntu 24.04 / 26.04 LTS.

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script must be run on Linux (Ubuntu 24.04 / 26.04 LTS)." >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Run this script as your regular user (it will invoke sudo when needed)." >&2
  exit 1
fi

ACTION="install"
for arg in "$@"; do
  case "${arg}" in
    --uninstall)
      ACTION="uninstall"
      ;;
    -h|--help)
      echo "Usage: $0 [--uninstall]"
      exit 0
      ;;
    *)
      echo "Unknown option: ${arg}" >&2
      echo "Usage: $0 [--uninstall]" >&2
      exit 1
      ;;
  esac
done

DROPIN_DIR="/etc/systemd/system/getty@tty1.service.d"
DROPIN_FILE="${DROPIN_DIR}/autologin.conf"
BASH_PROFILE="${HOME}/.bash_profile"
MARKER_START="# >>> surface-assistant-kiosk >>>"
MARKER_END="# <<< surface-assistant-kiosk <<<"

remove_profile_block() {
  local profile_file="$1"
  [[ -f "${profile_file}" ]] || return 0
  local tmp_file
  tmp_file="$(mktemp)"
  awk -v start="${MARKER_START}" -v end="${MARKER_END}" '
    $0 == start { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
  ' "${profile_file}" > "${tmp_file}"
  mv "${tmp_file}" "${profile_file}"
}

if [[ "${ACTION}" == "uninstall" ]]; then
  echo "==> Removing TTY1 autologin drop-in and ~/.bash_profile kiosk block..."
  sudo rm -f "${DROPIN_FILE}"
  sudo rmdir "${DROPIN_DIR}" 2>/dev/null || true
  remove_profile_block "${BASH_PROFILE}"
  sudo systemctl daemon-reload
  echo "TTY1 Sway kiosk autologin removed."
  exit 0
fi

echo "==> Configuring systemd getty@tty1 autologin for user '${USER}'..."
sudo mkdir -p "${DROPIN_DIR}"
sudo tee "${DROPIN_FILE}" >/dev/null <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin ${USER} --noclear %I \$TERM
EOF

echo "==> Updating ${BASH_PROFILE} with Sway TTY1 launch block..."
touch "${BASH_PROFILE}"
remove_profile_block "${BASH_PROFILE}"

if [[ -s "${BASH_PROFILE}" && -n "$(tail -n 1 "${BASH_PROFILE}")" ]]; then
  printf '\n' >> "${BASH_PROFILE}"
fi

cat <<'EOF' >> "${BASH_PROFILE}"
# >>> surface-assistant-kiosk >>>
if [[ -f "${HOME}/.profile" ]]; then
  # shellcheck source=/dev/null
  . "${HOME}/.profile"
elif [[ -f "${HOME}/.bashrc" ]]; then
  # shellcheck source=/dev/null
  . "${HOME}/.bashrc"
fi
if [[ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" && "$(tty 2>/dev/null || true)" == "/dev/tty1" ]] && command -v sway >/dev/null 2>&1; then
  exec sway
fi
# <<< surface-assistant-kiosk <<<
EOF

echo "==> Reloading systemd and enabling user linger for '${USER}'..."
sudo systemctl daemon-reload
sudo loginctl enable-linger "${USER}"

echo "TTY1 Sway kiosk autologin configured for '${USER}'."
