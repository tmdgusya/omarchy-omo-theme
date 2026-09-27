#!/usr/bin/env bash
set -uo pipefail

case "${1:-}" in
  -h|--help) echo "Usage: uninstall.sh   (reverses scripts/install.sh; keeps going past a refused step and lists it)"; exit 0 ;;
  "") ;;
  *) echo "Usage: uninstall.sh" >&2; exit 2 ;;
esac

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bindings="${OMO_HYPR_DIR:-$HOME/.config/hypr}/bindings.lua"
failed=()

step() {
  local name="$1"; shift
  printf '\n==> %s\n' "$name"
  "$@" || failed+=("$name")
}

step "OmO terminal palette" bash "$here/uninstall-pi-theme.sh"
step "Omarchy menu rows" bash "$here/uninstall-menu.sh"
if [[ -f "$bindings" ]] && grep -qF -- "-- >>> omo-launcher keybind" "$bindings"; then
  step "SUPER+ALT+O shortcut" bash "$here/uninstall-keybind.sh"
else
  printf '\n==> SUPER+ALT+O shortcut\nNot installed; nothing to remove.\n'
fi
step "Bar preset" bash "$here/uninstall-bar-preset.sh"
step "Bar widget, notifications, launcher service" bash "$here/uninstall-plugin.sh"

if (( ${#failed[@]} )); then
  printf '\nOmO was partly removed. These steps refused or failed (see messages above):\n' >&2
  printf '  - %s\n' "${failed[@]}" >&2
  exit 1
fi
printf '\nOmO is removed. Switch themes with: omarchy theme set <name>\n'
