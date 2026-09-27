#!/usr/bin/env bash
# uninstall-bar-preset.sh (no arguments)
# Env: OMO_CONFIG_ROOT (default ~/.config/omarchy), OMO_OMARCHY_BIN (default: omarchy on PATH).
set -euo pipefail

(( $# == 0 )) || { echo "Usage: $0" >&2; exit 2; }

config_root="${OMO_CONFIG_ROOT:-$HOME/.config/omarchy}"
config="$config_root/shell.json"
plugins="$config_root/plugins"
marker="$config_root/.omo-bar-preset.json"
preset_id="io.github.tmdgusya.omo-bar-preset"
omarchy_bin="${OMO_OMARCHY_BIN:-omarchy}"

widget_menu=io.github.tmdgusya.omo-menu-button
widget_workspaces=io.github.tmdgusya.omo-workspaces
widget_clock=io.github.tmdgusya.omo-clock
widget_usage=io.github.tmdgusya.omo-usage
widgets=("$widget_menu" "$widget_workspaces" "$widget_clock" "$widget_usage")

omarchy() { command "$omarchy_bin" "$@"; }
omarchy_shell() { omarchy-shell "$@"; }

layout_location() {
  jq -r --arg id "$1" '
    (.bar.layout // {}) as $layout
    | first(
        ("left", "center", "right") as $section
        | ($layout[$section] // []) | to_entries[]
        | select(((.value | type) == "object" and .value.id == $id) or .value == $id)
        | "\($section) \(.key)"
      ) // empty
  ' "$config"
}

in_layout() { [[ -n "$(layout_location "$1")" ]]; }

owned_plugin_ok() {
  local target="$plugins/$1"
  [[ -d "$target" && ! -L "$target" && -f "$target/.omo-install.json" && -f "$target/.omo-install.sha256" ]] || return 1
  jq -e --arg id "$1" --arg preset "$preset_id" \
    '.schema == 1 and .id == $id and .kind == "bar-preset" and .preset == $preset' \
    "$target/.omo-install.json" >/dev/null 2>&1 || return 1
  (cd "$target" && sha256sum -c .omo-install.sha256 >/dev/null 2>&1) || return 2
}

bar_signature() {
  jq -c '{
    position: (.bar.position // "top"),
    transparent: (.bar.transparent == true),
    anchor: (.bar.centerAnchor // ""),
    layout: [(.bar.layout // {}) | (.left // [], .center // [], .right // [])
             | map(if type == "object" then .id else . end)]
  }'
}

wait_shell_synced() {
  local attempt file_sig shell_sig
  for (( attempt = 0; attempt < 60; attempt++ )); do
    file_sig="$(bar_signature < "$config")"
    shell_sig="$(omarchy_shell shell listShellConfig 2>/dev/null | bar_signature 2>/dev/null || true)"
    [[ -n "$shell_sig" && "$shell_sig" == "$file_sig" ]] && return 0
    sleep 0.05
  done
  echo "omarchy-shell and $config disagree; wait for the shell to settle and run this again" >&2
  return 1
}

commit_center_anchor() {
  local tmp
  tmp="$(mktemp "$config_root/.shell.json.XXXXXXXX")"
  jq -S -e --arg anchor "$1" '.bar.centerAnchor = $anchor' "$config" > "$tmp" ||
    { rm -f -- "$tmp"; echo "could not update centerAnchor" >&2; exit 1; }
  mv -- "$tmp" "$config"
  omarchy_shell shell reloadConfig >/dev/null
}

restore_entry_settings() {
  local id="$1" entry="$2" key value
  while IFS= read -r key; do
    [[ -n "$key" && "$key" != id ]] || continue
    value="$(jq -c --arg key "$key" '.[$key]' <<<"$entry")"
    omarchy bar set "$id" "$key" "$value" --json
  done < <(jq -r 'keys[]' <<<"$entry")
}

[[ -f "$marker" && ! -L "$marker" ]] || { echo "The OmO bar preset is not installed (no $marker)" >&2; exit 1; }
jq -e --arg id "$preset_id" '.schema == 1 and .id == $id and (.prior | type) == "object"' "$marker" >/dev/null ||
  { echo "Refusing to act on a foreign marker: $marker" >&2; exit 1; }

owned=()
for id in "${widgets[@]}"; do
  target="$plugins/$id"
  [[ -e "$target" || -L "$target" ]] || continue
  if owned_plugin_ok "$id"; then owned+=("$id"); continue; fi
  case $? in
    2) echo "Installed plugin $id was edited; inspect it before removal" >&2 ;;
    *) echo "Refusing to remove unowned plugin: $target" >&2 ;;
  esac
  exit 1
done

[[ -f "$config" ]] || { echo "Missing shell.json; refusing to change layout" >&2; exit 1; }
jq -e '.version == 1' "$config" >/dev/null || { echo "Unsupported shell.json" >&2; exit 1; }
[[ "$(omarchy_shell shell ping)" == ok ]] || { echo "Omarchy shell is not running" >&2; exit 1; }
wait_shell_synced

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$config.bak.omo-bar.$stamp"
n=1
while [[ -e "$backup" ]]; do backup="$config.bak.omo-bar.$stamp.$n"; ((n+=1)); done
cp -p -- "$config" "$backup"
printf 'Saved layout backup: %s\n' "$backup"

prior_position="$(jq -r '.prior.position // "top"' "$marker")"
prior_transparent="$(jq -r 'if .prior.transparent == true then "true" else "false" end' "$marker")"
prior_anchor="$(jq -r '.prior.centerAnchor // ""' "$marker")"

for ours in "${widgets[@]}"; do
  in_layout "$ours" || continue
  original="$(jq -r --arg w "$ours" 'first(.replacements[]? | select(.widget == $w)) | .original // ""' "$marker")"
  entry="$(jq -c --arg w "$ours" 'first(.replacements[]? | select(.widget == $w)) | .entry // {}' "$marker")"
  if [[ -n "$original" ]]; then
    in_layout "$original" || omarchy bar put "$original" --before "$ours"
    if in_layout "$original"; then restore_entry_settings "$original" "$entry"; fi
  fi
  omarchy plugin disable "$ours"
  ! in_layout "$ours" || { echo "$ours is still on the bar" >&2; exit 1; }
done
wait_shell_synced

if [[ "$(jq -r '.bar.centerAnchor // ""' "$config")" == "$widget_clock" && "$prior_anchor" != "$widget_clock" ]]; then
  commit_center_anchor "$prior_anchor"
fi
if [[ "$(jq -r 'if .bar.transparent == true then "true" else "false" end' "$config")" != "$prior_transparent" ]]; then
  omarchy bar transparent "$prior_transparent"
fi
if [[ "$(jq -r '.bar.position // "top"' "$config")" != "$prior_position" ]]; then
  omarchy bar position "$prior_position"
fi
wait_shell_synced

for id in "${owned[@]}"; do
  rm -rf -- "$plugins/$id"
done
omarchy_shell shell rescanPlugins
rm -f -- "$marker"

printf 'Removed the OmO bar preset; restored the %s bar\n' "$prior_position"
