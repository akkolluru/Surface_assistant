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
GDM_CONF="/etc/gdm3/custom.conf"
GDM_BACKUP="/etc/gdm3/custom.conf.surface-backup"
ACCOUNTS_USER_FILE="/var/lib/AccountsService/users/${USER}"

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

has_gdm() {
  [[ -f "${GDM_CONF}" ]] && (systemctl is-enabled --quiet gdm3 2>/dev/null || systemctl is-enabled --quiet gdm 2>/dev/null || systemctl is-active --quiet gdm3 2>/dev/null || systemctl is-active --quiet gdm 2>/dev/null)
}

configure_gdm_sway() {
  echo "==> Configuring GDM autologin into Sway session for user '${USER}'..."
  if [[ ! -f "${GDM_BACKUP}" ]]; then
    sudo cp "${GDM_CONF}" "${GDM_BACKUP}"
  fi
  sudo python3 - "${GDM_CONF}" "${USER}" <<'PY'
import re
import sys
from pathlib import Path

conf_path = Path(sys.argv[1])
user = sys.argv[2]
lines = conf_path.read_text(encoding="utf-8").splitlines()

out = []
in_daemon = False
saw_daemon = False
keys = {
    "AutomaticLoginEnable": "True",
    "AutomaticLogin": user,
    "DefaultSession": "sway.desktop",
}
seen = set()

for line in lines:
    stripped = line.strip()
    if stripped.startswith("[") and stripped.endswith("]"):
        if in_daemon:
            for k, v in keys.items():
                if k not in seen:
                    out.append(f"{k}={v}")
            in_daemon = False
        if stripped.lower() == "[daemon]":
            in_daemon = True
            saw_daemon = True
        out.append(line)
        continue

    if in_daemon:
        matched = False
        for k, v in keys.items():
            if re.match(rf"^#?\s*{re.escape(k)}\s*=", stripped):
                if k not in seen:
                    out.append(f"{k}={v}")
                    seen.add(k)
                matched = True
                break
        if not matched:
            out.append(line)
    else:
        out.append(line)

if in_daemon:
    for k, v in keys.items():
        if k not in seen:
            out.append(f"{k}={v}")
elif not saw_daemon:
    out.append("[daemon]")
    for k, v in keys.items():
        out.append(f"{k}={v}")

conf_path.write_text("\n".join(out) + "\n", encoding="utf-8")
PY

  if command -v gdbus >/dev/null 2>&1; then
    sudo gdbus call --system --dest org.freedesktop.Accounts \
      --object-path "/org/freedesktop/Accounts/User$(id -u)" \
      --method org.freedesktop.Accounts.User.SetSession "sway" >/dev/null 2>&1 || true
    sudo gdbus call --system --dest org.freedesktop.Accounts \
      --object-path "/org/freedesktop/Accounts/User$(id -u)" \
      --method org.freedesktop.Accounts.User.SetXSession "sway" >/dev/null 2>&1 || true
  fi
  if [[ -d "/var/lib/AccountsService/users" ]]; then
    sudo python3 - "${ACCOUNTS_USER_FILE}" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
if path.exists():
    lines = path.read_text(encoding="utf-8").splitlines()
else:
    lines = ["[User]"]

out = []
saw_session = False
saw_xsession = False
for line in lines:
    if line.startswith("Session="):
        out.append("Session=sway")
        saw_session = True
    elif line.startswith("XSession="):
        out.append("XSession=sway")
        saw_xsession = True
    else:
        out.append(line)
if not saw_session:
    out.append("Session=sway")
if not saw_xsession:
    out.append("XSession=sway")
path.write_text("\n".join(out) + "\n", encoding="utf-8")
PY
    sudo systemctl try-restart accounts-daemon.service >/dev/null 2>&1 || true
  fi
}

if [[ "${ACTION}" == "uninstall" ]]; then
  echo "==> Removing Sway kiosk autologin configuration..."
  sudo rm -f "${DROPIN_FILE}"
  sudo rmdir "${DROPIN_DIR}" 2>/dev/null || true
  remove_profile_block "${BASH_PROFILE}"
  if [[ -f "${GDM_BACKUP}" ]]; then
    sudo mv "${GDM_BACKUP}" "${GDM_CONF}"
  fi
  sudo systemctl daemon-reload
  echo "Sway kiosk autologin removed."
  exit 0
fi

if has_gdm; then
  configure_gdm_sway
else
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
fi

echo "==> Reloading systemd and enabling user linger for '${USER}'..."
sudo systemctl daemon-reload
sudo loginctl enable-linger "${USER}"

echo "Sway kiosk autologin configured for '${USER}'."
