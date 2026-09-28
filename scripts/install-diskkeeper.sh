#!/usr/bin/env bash
set -euo pipefail

# omarchy:summary=Install the OmO diskkeeper (daily cold-file tidy) bundled with this theme
# omarchy:args=[--no-timer]

usage() {
  cat <<'USAGE'
Usage: install-diskkeeper.sh [--no-timer]

  --no-timer   Configure but do not enable the systemd timer
USAGE
}

timer=true
while (( $# )); do
  case "$1" in
    --no-timer) timer=false ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tool="$here/../tools/diskkeeper"

if ! command -v bun >/dev/null 2>&1; then
  printf '==> OmO diskkeeper skipped: bun not found.\n'
  printf '    Install bun (https://bun.sh) and re-run install.sh to get the daily tidy.\n'
  exit 0
fi

printf '==> OmO diskkeeper: init\n'
bun "$tool/src/cli.ts" init

if bun "$tool/src/cli.ts" config-get uuid >/dev/null 2>&1 && [[ -n "$(bun "$tool/src/cli.ts" config-get uuid 2>/dev/null)" ]]; then
  printf '    Archive disk already configured; keeping it.\n'
else
  printf '==> OmO diskkeeper: pick the archive disk\n'
  if ! bun "$tool/src/cli.ts" setup; then
    printf '    Skipped disk selection — the timer will only report "not configured" until you run setup.\n'
  fi
fi

if [[ "$timer" == true ]]; then
  printf '==> OmO diskkeeper: systemd timer\n'
  bun "$tool/src/cli.ts" install
else
  printf '==> OmO diskkeeper: timer skipped (--no-timer)\n'
fi

cat <<'DONE'

OmO diskkeeper is set up.
  - Every day at 10:30 OmO scans cold, large files (14+ days untouched),
    proposes moving them to your archive disk and leaves a symlink behind.
  - It starts in PROPOSAL mode: nothing moves until you run
      bun ~/omarchy-omo-theme/tools/diskkeeper/src/cli.ts go
  - Restore anything with:  .../cli.ts restore <original-path>
DONE
