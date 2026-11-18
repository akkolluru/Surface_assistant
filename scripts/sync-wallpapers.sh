#!/usr/bin/env bash
set -euo pipefail

# Syncs local ./wallpapers/ and/or downloads DenverCoder1 minimalistic wallpapers
# into ~/wallpapers/static/ on the Surface Pro 5 over SSH (no runtime API needed).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

SURFACE_USER="${SURFACE_USER:-time-master}"
SURFACE_HOST="${SURFACE_HOST:-192.168.0.100}"
REMOTE_WALLPAPERS_ROOT="${REMOTE_WALLPAPERS_ROOT:-~/wallpapers}"
MINIMALISTIC_TARBALL_URL="${MINIMALISTIC_TARBALL_URL:-https://codeload.github.com/DenverCoder1/minimalistic-wallpaper-collection/tar.gz/refs/heads/main}"

WITH_MINIMALISTIC=false
ONLY_MINIMALISTIC=false
DRY_RUN=false

usage() {
  cat <<'EOF'
Usage: ./scripts/sync-wallpapers.sh [OPTIONS]

Populate ~/wallpapers/static/ on the Surface Pro 5 without external runtime APIs.

Options:
  --with-minimalistic  Download images from DenverCoder1/minimalistic-wallpaper-collection and sync to Surface
  --only-minimalistic  Only download DenverCoder1/minimalistic-wallpaper-collection (skip local ./wallpapers/)
  --dry-run            Preview rsync/remote operations without modifying the Surface
  -h, --help           Show this help message and exit

Environment Variables:
  SURFACE_USER            SSH username (default: time-master)
  SURFACE_HOST            SSH host/IP  (default: 192.168.0.100)
  REMOTE_WALLPAPERS_ROOT  Remote wallpapers root (default: ~/wallpapers)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-minimalistic)
      WITH_MINIMALISTIC=true
      shift
      ;;
    --only-minimalistic)
      WITH_MINIMALISTIC=true
      ONLY_MINIMALISTIC=true
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

if [[ "${REMOTE_WALLPAPERS_ROOT}" != "/" ]]; then
  REMOTE_WALLPAPERS_ROOT="${REMOTE_WALLPAPERS_ROOT%/}"
fi

if [[ "${REMOTE_WALLPAPERS_ROOT}" == "~" ]]; then
  REMOTE_MKDIR_CMD='mkdir -p "$HOME/static" "$HOME/loops"'
  REMOTE_STATIC_RSYNC='static/'
elif [[ "${REMOTE_WALLPAPERS_ROOT}" == "~/"* ]]; then
  REL_ROOT="${REMOTE_WALLPAPERS_ROOT#\~/}"
  printf -v ESCAPED_REL_ROOT '%q' "${REL_ROOT}"
  REMOTE_MKDIR_CMD="mkdir -p \"\$HOME\"/${ESCAPED_REL_ROOT}/static \"\$HOME\"/${ESCAPED_REL_ROOT}/loops"
  REMOTE_STATIC_RSYNC="${REL_ROOT}/static/"
else
  printf -v ESCAPED_ROOT '%q' "${REMOTE_WALLPAPERS_ROOT}"
  REMOTE_MKDIR_CMD="mkdir -p ${ESCAPED_ROOT}/static ${ESCAPED_ROOT}/loops"
  REMOTE_STATIC_RSYNC="${ESCAPED_ROOT}/static/"
fi

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[dry-run] Would ensure remote directories: ssh ${REMOTE_TARGET} ${REMOTE_MKDIR_CMD}"
else
  ssh "${REMOTE_TARGET}" "${REMOTE_MKDIR_CMD}"
fi

if [[ "${WITH_MINIMALISTIC}" == "true" ]]; then
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "[dry-run] Would download ${MINIMALISTIC_TARBALL_URL} (images/) and rsync into ${REMOTE_WALLPAPERS_ROOT}/static on ${REMOTE_TARGET}"
  else
    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "${TMP_DIR}"' EXIT
    echo "Downloading minimalistic-wallpaper-collection archive..."
    curl -fSL --http1.1 --retry 5 --retry-delay 2 "${MINIMALISTIC_TARBALL_URL}" -o "${TMP_DIR}/minimalistic.tar.gz"
    mkdir -p "${TMP_DIR}/images"
    python3 - "${TMP_DIR}/minimalistic.tar.gz" "${TMP_DIR}/images" <<'PY'
import pathlib
import shutil
import sys
import tarfile

archive_path = pathlib.Path(sys.argv[1])
out_dir = pathlib.Path(sys.argv[2])
valid_exts = {".jpg", ".jpeg", ".png", ".webp"}
count = 0

with tarfile.open(archive_path, "r:gz") as tf:
    for member in tf.getmembers():
        if not member.isfile():
            continue
        parts = pathlib.PurePosixPath(member.name).parts
        if len(parts) != 3 or parts[1] != "images":
            continue
        filename = parts[2]
        if pathlib.PurePosixPath(filename).suffix.lower() not in valid_exts:
            continue
        src = tf.extractfile(member)
        if src is None:
            continue
        with src, (out_dir / filename).open("wb") as dst:
            shutil.copyfileobj(src, dst)
        count += 1

print(f"Extracted {count} minimalistic wallpapers.")
PY
    echo "Syncing minimalistic-wallpaper-collection -> ${REMOTE_TARGET}:${REMOTE_WALLPAPERS_ROOT}/static/"
    rsync -av --partial --ignore-existing -e ssh "${TMP_DIR}/images/" "${REMOTE_TARGET}:${REMOTE_STATIC_RSYNC}"
  fi
fi

if [[ "${ONLY_MINIMALISTIC}" != "true" ]]; then
  LOCAL_DIR="${REPO_ROOT}/wallpapers"
  if [[ ! -d "${LOCAL_DIR}" ]]; then
    echo "Warning: Local wallpapers directory '${LOCAL_DIR}' does not exist; skipping." >&2
  else
    RSYNC_ARGS=(
      -av
      --partial
      -e ssh
      --exclude='.DS_Store'
      --exclude='loops/'
      --exclude='static/'
    )
    if [[ "${DRY_RUN}" == "true" ]]; then
      RSYNC_ARGS+=(--dry-run)
    fi
    echo "Syncing local ${LOCAL_DIR}/ -> ${REMOTE_TARGET}:${REMOTE_WALLPAPERS_ROOT}/static/"
    rsync "${RSYNC_ARGS[@]}" "${LOCAL_DIR}/" "${REMOTE_TARGET}:${REMOTE_STATIC_RSYNC}"
  fi
fi

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[dry-run] Would refresh running daemon wallpaper index via POST /api/wallpapers/refresh"
else
  ssh "${REMOTE_TARGET}" 'curl -fsS -X POST http://127.0.0.1:8000/api/wallpapers/refresh >/dev/null 2>&1 || true'
fi

echo "Wallpaper sync complete."
