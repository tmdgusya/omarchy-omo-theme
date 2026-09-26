#!/usr/bin/env bash
set -euo pipefail

(( $# == 0 )) || { echo "Usage: $0" >&2; exit 2; }
id=io.github.tmdgusya.omo
config="$HOME/.config/omarchy/shell.json"
target="$HOME/.config/omarchy/plugins/$id"
marker="$target/.omo-install.json"

[[ -d "$target" && ! -L "$target" && -f "$marker" && -f "$target/.omo-install.sha256" ]] ||
  { echo "No owned plugin at $target; nothing removed" >&2; exit 1; }
jq -e --arg id "$id" '.schema == 1 and .id == $id' "$marker" >/dev/null ||
  { echo "Refusing to remove an unowned plugin" >&2; exit 1; }
(cd "$target" && sha256sum -c .omo-install.sha256 >/dev/null) ||
  { echo "Installed plugin was edited; inspect it before removal" >&2; exit 1; }
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
omarchy plugin remove "$id" --yes
printf 'Removed %s; switch away from the omo theme before removing it.\n' "$id"
