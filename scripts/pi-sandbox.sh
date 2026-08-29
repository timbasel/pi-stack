#!/usr/bin/env bash
set -euo pipefail

PI_BIN="${HOME}/.local/bin/pi"
PI_CODING_AGENT_DIR=${PI_CODING_AGENT_DIR:-"${HOME}/.pi/agent"}
WORKSPACE=$(pwd -P)

exec bwrap \
  --unshare-all \
  --share-net \
  --die-with-parent \
  --new-session \
  \
  --ro-bind /usr /usr \
  --symlink usr/bin /bin \
  --symlink usr/bin /sbin \
  --symlink usr/lib /lib \
  --symlink usr/lib /lib64 \
  --ro-bind /etc /etc \
  --ro-bind-try /opt /opt \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  \
  --dir "${HOME}" \
  --dir "$(dirname "${PI_CODING_AGENT_DIR}")" \
  --dir "$(dirname "${WORKSPACE}")" \
  --ro-bind "${HOME}/.local" "${HOME}/.local" \
  --ro-bind-try "${HOME}/.agents" "${HOME}/.agents" \
  --ro-bind "${PI_CODING_AGENT_DIR}" "${PI_CODING_AGENT_DIR}" \
  \
  --bind-try "${PI_CODING_AGENT_DIR}/auth.json" "${PI_CODING_AGENT_DIR}/auth.json" \
  --bind-try "${PI_CODING_AGENT_DIR}/sessions" "${PI_CODING_AGENT_DIR}/sessions" \
  --bind-try "${PI_CODING_AGENT_DIR}/trust.json" "${PI_CODING_AGENT_DIR}/trust.json" \
  \
  --bind "${WORKSPACE}" "${WORKSPACE}" \
  --chdir "${WORKSPACE}" \
  \
  --setenv HOME "${HOME}" \
  --setenv PI_CODING_AGENT_DIR "${PI_CODING_AGENT_DIR}" \
  --setenv PI_OFFLINE 1 \
  --setenv PATH "${PI_CODING_AGENT_DIR}/bin:${HOME}/.local/bin:/usr/local/bin:/usr/bin" \
  \
  "${PI_BIN}" "${@}"
