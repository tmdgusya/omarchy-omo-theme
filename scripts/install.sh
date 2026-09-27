#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: install.sh [--position top|left] [--no-keybind] [--no-menu] [--no-pi-theme]

  --position top|left  Bar preset (default: top, 32px; left is 36px wide)
  --no-keybind         Do not add SUPER+ALT+O to ~/.config/hypr/bindings.lua
  --no-menu            Do not add the OmO rows to the Omarchy menu
  --no-pi-theme        Do not select the OmO palette for omo/senpi
USAGE
}

position=top keybind=true menu=true pi_theme=true
while (( $# )); do
  case "$1" in
    --position) [[ $# -ge 2 ]] || { usage >&2; exit 2; }; position="$2"; shift ;;
    --position=*) position="${1#*=}" ;;
    --no-keybind) keybind=false ;;
    --no-menu) menu=false ;;
    --no-pi-theme) pi_theme=false ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done
[[ "$position" == top || "$position" == left ]] || { echo "--position must be top or left" >&2; exit 2; }

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bindings="${OMO_HYPR_DIR:-$HOME/.config/hypr}/bindings.lua"
keybind_marker="-- >>> omo-launcher keybind"

step() {
  local name="$1"; shift
  printf '\n==> %s\n' "$name"
  if ! "$@"; then
    printf '\nOmO install stopped at: %s\nNothing after this step ran. Fix the message above and re-run install.sh.\n' "$name" >&2
    exit 1
  fi
}

step "Bar widget, notifications, launcher service" bash "$here/install-plugin.sh" --track-all-sessions
step "Bar preset ($position)" bash "$here/install-bar-preset.sh" --position "$position"

if [[ "$keybind" == true ]]; then
  if [[ -f "$bindings" ]] && grep -qF -- "$keybind_marker" "$bindings"; then
    printf '\n==> SUPER+ALT+O shortcut\nAlready installed; left as is.\n'
  else
    step "SUPER+ALT+O shortcut" bash "$here/install-keybind.sh"
  fi
fi
[[ "$menu" == true ]] && step "Omarchy menu rows" bash "$here/install-menu.sh"
[[ "$pi_theme" == true ]] && step "OmO terminal palette" bash "$here/install-pi-theme.sh"

cat <<DONE

OmO is installed.
  - Press SUPER+ALT+O, type what you want done, press Enter.
  - Click the cat in the bar to see your sessions.
  - Check the install: bash "$here/verify-install.sh"
  - Remove everything: bash "$here/uninstall.sh"
Sessions that were already running pick up live tracking after /reload.
DONE
