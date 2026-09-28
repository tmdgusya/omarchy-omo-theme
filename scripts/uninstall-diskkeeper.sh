#!/usr/bin/env bash
set -euo pipefail

# omarchy:summary=Remove the OmO diskkeeper timer (config, index and reports are kept)

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tool="$here/../tools/diskkeeper"

if command -v bun >/dev/null 2>&1 && [[ -d "$tool" ]]; then
  bun "$tool/src/cli.ts" uninstall-timer || true
else
  systemctl --user disable --now omo-diskkeeper.timer 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/omo-diskkeeper.service" "$HOME/.config/systemd/user/omo-diskkeeper.timer"
  systemctl --user daemon-reload || true
  printf 'OmO diskkeeper timer removed.\n'
fi
printf 'Kept for data safety: %s (index for restore) and %s\n' \
  "$HOME/.local/state/omo-diskkeeper" "$HOME/.config/omo-diskkeeper/config.json"
