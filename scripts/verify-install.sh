#!/usr/bin/env bash
set -uo pipefail

case "${1:-}" in
  -h|--help) echo "Usage: verify-install.sh   (prints PASS/FAIL per OmO component; exits 1 if any FAIL)"; exit 0 ;;
  "") ;;
  *) echo "Usage: verify-install.sh" >&2; exit 2 ;;
esac

config_root="${OMO_CONFIG_ROOT:-$HOME/.config/omarchy}"
hypr_dir="${OMO_HYPR_DIR:-$HOME/.config/hypr}"
state_theme="${OMO_THEME_NAME_FILE:-$HOME/.local/state/omarchy/current/theme.name}"
agent_dir="${SENPI_CODING_AGENT_DIR:-${OMO_CODING_AGENT_DIR:-$HOME/.omo/agent}}"
shell_json="$config_root/shell.json"
plugin_dir="$config_root/plugins/io.github.tmdgusya.omo"
preset_marker="$config_root/.omo-bar-preset.json"
menu_file="$config_root/extensions/omarchy-menu.jsonc"
fails=0

check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf 'PASS  %s\n' "$label"
  else
    printf 'FAIL  %s\n' "$label"
    fails=$((fails + 1))
  fi
}

in_layout() {
  jq -e --arg id "$1" '[.bar.layout[]?[]?.id] | index($id) != null' "$shell_json"
}

check "theme 'omo' is selected" grep -qx omo "$state_theme"
check "OmO plugin is installed and owned" test -f "$plugin_dir/manifest.json" -a -f "$plugin_dir/.omo-install.json"
check "OmO cat cell is in the bar" in_layout io.github.tmdgusya.omo

if [[ -f "$preset_marker" ]]; then
  position="$(jq -r '.preset // empty' "$preset_marker" 2>/dev/null)"
  [[ -n "$position" ]] && check "bar position is '$position'" jq -e --arg p "$position" '.bar.position == $p' "$shell_json"
  check "OmO menu button is in the bar" in_layout io.github.tmdgusya.omo-menu-button
  check "OmO ring workspaces are in the bar" in_layout io.github.tmdgusya.omo-workspaces
  check "OmO clock is in the bar" in_layout io.github.tmdgusya.omo-clock
  check "OmO provider usage is in the bar" in_layout io.github.tmdgusya.omo-usage
else
  printf 'SKIP  bar preset (not installed; run scripts/install-bar-preset.sh)\n'
fi

if grep -qF -- "-- >>> omo-launcher keybind" "$hypr_dir/bindings.lua" 2>/dev/null; then
  check "SUPER+ALT+O line is in bindings.lua" grep -qF 'omarchy-shell omoLauncher toggle' "$hypr_dir/bindings.lua"
  if command -v hyprctl >/dev/null && [[ -z "${OMO_HYPR_DIR:-}" ]]; then
    check "Hyprland has loaded SUPER+ALT+O" bash -c "hyprctl binds -j | jq -e '.[] | select(.key == \"O\" and .modmask == 72)'"
  fi
else
  printf 'SKIP  SUPER+ALT+O shortcut (not installed; run scripts/install-keybind.sh)\n'
fi

check "OmO launch row is in the Omarchy menu" grep -q '"omo-launch"' "$menu_file"

if [[ -z "${OMO_CONFIG_ROOT:-}" ]] && command -v qs >/dev/null && [[ -n "${OMARCHY_PATH:-}" ]]; then
  check "running shell answers omoLauncher" bash -c "qs ipc -p \"\$OMARCHY_PATH/shell\" show | grep -q omoLauncher"
fi

check "omo or senpi is on PATH" bash -c 'command -v omo || command -v senpi'
check "OmO palette file exists for omo/senpi" test -f "$agent_dir/themes/omo-nightsea.json"

echo
if (( fails )); then
  echo "$fails check(s) failed. Re-run: bash \"$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/install.sh\""
  exit 1
fi
echo "OmO looks fully installed. Press SUPER+ALT+O to start."
