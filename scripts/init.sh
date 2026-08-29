#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
SOURCE="${SCRIPT_DIR}/pi-sandbox.sh"
DEST_DIR="${HOME}/.config/pi/bin"
DEST="${DEST_DIR}/pi"

if ! command -v bwrap >/dev/null 2>&1; then
  printf 'error: bubblewrap (bwrap) is required but was not found in PATH\n' >&2
  exit 1
fi

if [[ ! -x "${SOURCE}" ]]; then
  printf 'error: sandbox launcher is not executable: %s\n' "${SOURCE}" >&2
  exit 1
fi

mkdir -p -- "${DEST_DIR}"

if [[ -e "${DEST}" && ! -L "${DEST}" ]]; then
  printf 'error: refusing to replace existing file: %s\n' "${DEST}" >&2
  exit 1
fi

ln -sfn -- "${SOURCE}" "${DEST}"

printf 'Installed pi sandbox launcher:\n  %s -> %s\n' "${DEST}" "${SOURCE}"
printf 'Ensure %s appears before the real pi binary in PATH.\n' "${DEST_DIR}"
