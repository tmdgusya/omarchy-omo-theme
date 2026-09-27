#!/usr/bin/env bash
set -euo pipefail

(( $# == 0 )) || { echo "Usage: $0" >&2; exit 2; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
helper="$root/scripts/jsonc-edit.py"
source_file="$root/menu/omarchy-menu.omo.jsonc"
extensions="$HOME/.config/omarchy/extensions"
target="$extensions/omarchy-menu.jsonc"
marker="$extensions/omarchy-menu.omo-install.json"

[[ -f "$source_file" && -x "$helper" ]] ||
  { echo "Bundled menu installer is incomplete" >&2; exit 1; }
[[ ! -e "$target" || (-f "$target" && ! -L "$target") ]] ||
  { echo "Refusing to edit non-regular menu config: $target" >&2; exit 1; }
[[ ! -e "$marker" || (-f "$marker" && ! -L "$marker") ]] ||
  { echo "Refusing to use non-regular ownership marker: $marker" >&2; exit 1; }

fragment="$(python3 "$helper" dump "$source_file")"
session_action="$(printf '%q --pick' "$root/menu/omo-menu-sessions")"
fragment="$(jq -c --arg action "$session_action" '."omo.sessions".action = $action' <<<"$fragment")"
owned_keys="$(jq -c 'keys | sort' <<<"$fragment")"
created_target=false
base_text=null

if [[ -f "$marker" ]]; then
  jq -e --arg target "$target" --argjson keys "$owned_keys" '
    .schema == 1 and .id == "omo-menu" and .target == $target and
    .ownedKeys == $keys and (.applied | type == "object")
  ' "$marker" >/dev/null || { echo "Invalid menu ownership marker" >&2; exit 1; }
  current="$(python3 "$helper" state "$target" "$owned_keys")"
  jq -e --argjson current "$current" '
    .applied as $applied |
    all(.ownedKeys[]; $current[.].exists == true and $current[.].value == $applied[.])
  ' "$marker" >/dev/null ||
    { echo "Owned menu entries were edited; refusing to overwrite them" >&2; exit 1; }
  prior_hash="$(jq -r '.installedSha256 // ""' "$marker")"
  current_hash="$(sha256sum "$target" | cut -d' ' -f1)"
  if [[ "$current_hash" == "$prior_hash" ]]; then
    created_target="$(jq -r '.createdTarget' "$marker")"
    base_text="$(jq -c '.baseText' "$marker")"
  fi
else
  if [[ -f "$target" ]]; then
    current="$(python3 "$helper" state "$target" "$owned_keys")"
    jq -e 'all(.[]; .exists == false)' <<<"$current" >/dev/null ||
      { echo "Refusing to claim existing omo.* menu entries" >&2; exit 1; }
  else
    created_target=true
  fi
  if [[ -f "$target" ]]; then
    base_text="$(jq -Rs . <"$target")"
  else
    base_text='""'
  fi
fi

mkdir -p -- "$extensions"
if [[ -f "$target" ]]; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$target.bak.omo.$stamp"
  n=1
  while [[ -e "$backup" ]]; do backup="$target.bak.omo.$stamp.$n"; ((n+=1)); done
  cp -p -- "$target" "$backup"
  printf 'Saved menu backup: %s\n' "$backup"
fi
python3 "$helper" merge "$target" "$fragment"
installed_hash="$(sha256sum "$target" | cut -d' ' -f1)"
temporary="$(mktemp "$extensions/.omo-menu-marker.XXXXXXXX")"
trap 'rm -f -- "$temporary"' EXIT
jq -n --arg target "$target" --argjson keys "$owned_keys" --argjson applied "$fragment" \
  --argjson created "$created_target" --argjson base "$base_text" --arg hash "$installed_hash" \
  '{schema:1,id:"omo-menu",target:$target,ownedKeys:$keys,applied:$applied,
    createdTarget:$created,baseText:$base,installedSha256:$hash}' \
  >"$temporary"
chmod 600 "$temporary"
mv -f -- "$temporary" "$marker"
printf 'Installed OmO menu entries\n'
