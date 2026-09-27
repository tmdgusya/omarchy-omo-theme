#!/usr/bin/env bash
set -euo pipefail

(( $# == 0 )) || { echo "Usage: $0" >&2; exit 2; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
helper="$root/scripts/jsonc-edit.py"
extensions="$HOME/.config/omarchy/extensions"
target="$extensions/omarchy-menu.jsonc"
marker="$extensions/omarchy-menu.omo-install.json"

[[ -f "$marker" && ! -L "$marker" && -f "$target" && ! -L "$target" ]] ||
  { echo "No owned OmO menu installation; nothing removed" >&2; exit 1; }
owned_keys="$(jq -c '.ownedKeys' "$marker")"
jq -e --arg target "$target" '
  .schema == 1 and .id == "omo-menu" and .target == $target and
  (.ownedKeys | type == "array") and (.applied | type == "object")
' "$marker" >/dev/null || { echo "Invalid menu ownership marker" >&2; exit 1; }
current="$(python3 "$helper" state "$target" "$owned_keys")"
jq -e --argjson current "$current" '
  .applied as $applied |
  all(.ownedKeys[]; $current[.].exists == true and $current[.].value == $applied[.])
' "$marker" >/dev/null ||
  { echo "Owned menu entries were edited; refusing to remove them" >&2; exit 1; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$target.bak.omo.$stamp"
n=1
while [[ -e "$backup" ]]; do backup="$target.bak.omo.$stamp.$n"; ((n+=1)); done
cp -p -- "$target" "$backup"
printf 'Saved menu backup: %s\n' "$backup"
installed_hash="$(jq -r '.installedSha256 // ""' "$marker")"
current_hash="$(sha256sum "$target" | cut -d' ' -f1)"
if [[ "$current_hash" == "$installed_hash" ]] && jq -e '.baseText != null' "$marker" >/dev/null; then
  if [[ "$(jq -r '.createdTarget' "$marker")" == true ]]; then
    rm -- "$target"
  else
    temporary="$(mktemp "$extensions/.omo-menu-config.XXXXXXXX")"
    trap 'rm -f -- "$temporary"' EXIT
    jq -j '.baseText' "$marker" >"$temporary"
    chmod --reference="$target" "$temporary"
    mv -f -- "$temporary" "$target"
  fi
else
  python3 "$helper" remove "$target" "$owned_keys"
fi
rm -- "$marker"
printf 'Removed owned OmO menu entries\n'
