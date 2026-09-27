#!/usr/bin/env bash
set -euo pipefail

(( $# == 0 )) || { echo "Usage: $0" >&2; exit 2; }
id=io.github.tmdgusya.omo
config="$HOME/.config/omarchy/shell.json"
plugins="$HOME/.config/omarchy/plugins"
target="$plugins/$id"
marker="$target/.omo-install.json"
layers_parent="$plugins/art"
layers_target="$layers_parent/layers"
layers_marker="$layers_target/.omo-install.json"

[[ -d "$target" && ! -L "$target" && -f "$marker" && -f "$target/.omo-install.sha256" ]] ||
  { echo "No owned plugin at $target; nothing removed" >&2; exit 1; }
jq -e --arg id "$id" '.schema == 1 and .id == $id' "$marker" >/dev/null ||
  { echo "Refusing to remove an unowned plugin" >&2; exit 1; }
(cd "$target" && sha256sum -c .omo-install.sha256 >/dev/null) ||
  { echo "Installed plugin was edited; inspect it before removal" >&2; exit 1; }
remove_layers=false
if [[ -e "$layers_target" || -L "$layers_target" ]]; then
  [[ -d "$layers_target" && ! -L "$layers_target" && -f "$layers_marker" && -f "$layers_target/.omo-install.sha256" ]] ||
    { echo "Refusing to remove unowned ambient layers" >&2; exit 1; }
  jq -e --arg id "$id" '.schema == 1 and .id == $id and .kind == "ambient-layers"' "$layers_marker" >/dev/null ||
    { echo "Refusing to remove unowned ambient layers" >&2; exit 1; }
  (cd "$layers_target" && sha256sum -c .omo-install.sha256 >/dev/null) ||
    { echo "Installed ambient layers were edited; inspect them before removal" >&2; exit 1; }
  remove_layers=true
fi
[[ -f "$config" ]] || { echo "Missing shell.json; refusing to change layout" >&2; exit 1; }
jq -e '.version == 1' "$config" >/dev/null || { echo "Unsupported shell.json" >&2; exit 1; }
[[ "$(omarchy-shell shell ping)" == ok ]] || { echo "Omarchy shell is not running" >&2; exit 1; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$config.bak.omo.$stamp"
n=1
while [[ -e "$backup" ]]; do backup="$config.bak.omo.$stamp.$n"; ((n+=1)); done
cp -p -- "$config" "$backup"
printf 'Saved layout backup: %s\n' "$backup"

original_position="$(jq -r '.originalPosition // ""' "$marker")"
current_position="$(jq -r '.bar.position // "top"' "$config")"
if [[ -n "$original_position" && "$current_position" == top ]]; then
  omarchy bar position "$original_position"
fi
if jq -e --arg id "$id" '
  any([.bar.layout.left[]?, .bar.layout.center[]?, .bar.layout.right[]?, .plugins[]?][]; .id == $id)
' "$config" >/dev/null; then
  omarchy plugin disable "$id"
fi
tracking_source="$(jq -r '.trackingSource // ""' "$marker")"
if [[ -n "$tracking_source" ]]; then
  tracking_agent="$(jq -r '.trackingAgentDir' "$marker")"
  [[ "$tracking_source" == "$target/omo-status.ts" && "$tracking_agent" == /* ]] ||
    { echo "Invalid tracking ownership marker" >&2; exit 1; }
  SENPI_CODING_AGENT_DIR="$tracking_agent" senpi remove "$tracking_source"
fi
omarchy plugin remove "$id" --yes
if [[ "$remove_layers" == true ]]; then
  rm -rf -- "$layers_target"
  rmdir -- "$layers_parent" 2>/dev/null || true
fi
printf 'Removed %s; switch away from the omo theme before removing it.\n' "$id"
