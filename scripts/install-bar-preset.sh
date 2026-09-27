#!/usr/bin/env bash
# install-bar-preset.sh [--position top|left]   (default: top)
# Env: OMO_CONFIG_ROOT (default ~/.config/omarchy), OMO_OMARCHY_BIN (default: omarchy on PATH).
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
extras="$root/extras"
config_root="${OMO_CONFIG_ROOT:-$HOME/.config/omarchy}"
config="$config_root/shell.json"
plugins="$config_root/plugins"
marker="$config_root/.omo-bar-preset.json"
preset_id="io.github.tmdgusya.omo-bar-preset"
defaults_config="${OMARCHY_PATH:-/usr/share/omarchy}/config/omarchy/shell.json"
omarchy_bin="${OMO_OMARCHY_BIN:-omarchy}"
position=top

widget_menu=io.github.tmdgusya.omo-menu-button
widget_workspaces=io.github.tmdgusya.omo-workspaces
widget_clock=io.github.tmdgusya.omo-clock
widget_usage=io.github.tmdgusya.omo-usage
widgets=("$widget_menu" "$widget_workspaces" "$widget_clock" "$widget_usage")

usage() { echo "Usage: $0 [--position top|left]" >&2; }

while (( $# > 0 )); do
  case "$1" in
    --position) [[ -n "${2:-}" ]] || { usage; exit 2; }; position="$2"; shift 2 ;;
    --position=*) position="${1#--position=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done
[[ "$position" == top || "$position" == left ]] || { echo "position must be top or left" >&2; exit 2; }

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

layout_entry() {
  local location section index
  location="$(layout_location "$1")"
  [[ -n "$location" ]] || { echo '{}'; return; }
  read -r section index <<<"$location"
  jq -c --arg section "$section" --argjson index "$index" \
    '.bar.layout[$section][$index] | if type == "object" then . else {id: .} end' "$config"
}

candidates_for() {
  local source="$1" manifest dir
  printf '%s\n' "$source"
  [[ "$source" == omarchy.workspaces ]] && printf '%s\n' roach.workspaces
  for manifest in "$plugins"/*/manifest.json; do
    [[ -f "$manifest" ]] || continue
    dir="$(basename -- "$(dirname -- "$manifest")")"
    [[ "$dir" != .* ]] || continue
    if jq -e --arg source "$source" '.omarchy.clonedFrom == $source' "$manifest" >/dev/null 2>&1; then
      printf '%s\n' "$dir"
    fi
  done
}

find_original() {
  local candidate
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    if in_layout "$candidate"; then printf '%s\n' "$candidate"; return 0; fi
  done < <(candidates_for "$1" | awk '!seen[$0]++')
  return 1
}

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

for id in "${widgets[@]}"; do
  source_dir="$extras/$id"
  [[ -f "$source_dir/manifest.json" ]] ||
    { echo "Bundled preset is incomplete: missing extras/$id/manifest.json" >&2; exit 1; }
  jq -e --arg id "$id" '.id == $id and .schemaVersion == 1 and (.kinds | index("bar-widget")) != null' \
    "$source_dir/manifest.json" >/dev/null || { echo "Bundled plugin $id has a wrong manifest" >&2; exit 1; }
  entry="$(jq -r '.entryPoints.barWidget // ""' "$source_dir/manifest.json")"
  [[ -n "$entry" && -f "$source_dir/$entry" ]] ||
    { echo "Bundled plugin $id is missing its bar widget entry point" >&2; exit 1; }
  omarchy plugin validate "$source_dir"
done
[[ "$(omarchy_shell shell ping)" == ok ]] || { echo "Omarchy shell is not running" >&2; exit 1; }

for id in "${widgets[@]}"; do
  target="$plugins/$id"
  if [[ -e "$target" || -L "$target" ]]; then
    if owned_plugin_ok "$id"; then continue; fi
    case $? in
      2) echo "Installed plugin $id was edited; refusing to overwrite it" >&2 ;;
      *) echo "Refusing to overwrite unowned plugin: $target" >&2 ;;
    esac
    exit 1
  fi
done

if [[ -e "$marker" ]]; then
  [[ -f "$marker" && ! -L "$marker" ]] || { echo "Refusing to touch $marker" >&2; exit 1; }
  jq -e --arg id "$preset_id" '.schema == 1 and .id == $id' "$marker" >/dev/null ||
    { echo "Refusing to touch a foreign marker: $marker" >&2; exit 1; }
fi

had_config=true
if [[ ! -f "$config" ]]; then
  [[ -f "$defaults_config" ]] ||
    { echo "No shell.json at $config and no Omarchy defaults to seed it from" >&2; exit 1; }
  had_config=false
  omarchy bar position "$(jq -r '.bar.position // "top"' "$defaults_config")" >/dev/null
fi
[[ -f "$config" ]] || { echo "Missing shell.json after seeding; aborting" >&2; exit 1; }
jq -e '.version == 1' "$config" >/dev/null || { echo "Unsupported shell.json" >&2; exit 1; }
wait_shell_synced

mkdir -p -- "$plugins"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$config.bak.omo-bar.$stamp"
n=1
while [[ -e "$backup" ]]; do backup="$config.bak.omo-bar.$stamp.$n"; ((n+=1)); done
cp -p -- "$config" "$backup"
printf 'Saved layout backup: %s\n' "$backup"

if [[ -f "$marker" ]]; then
  prior="$(jq -c '.prior' "$marker")"
  had_config="$(jq -r 'if has("hadConfig") then .hadConfig else true end' "$marker")"
  original_backup="$(jq -r '.backup // ""' "$marker")"
  replacements="$(jq -c '.replacements // []' "$marker")"
else
  prior="$(jq -c '{
    position: (.bar.position // "top"),
    transparent: (.bar.transparent == true),
    centerAnchor: (.bar.centerAnchor // ""),
    layout: (.bar.layout // {})
  }' "$config")"
  original_backup="$backup"
  replacements='[]'
fi

declare -A replaces=()
plan_replacement() {
  local ours="$1" source="$2" original="" entry='{}' section="" index=""
  if jq -e --arg w "$ours" 'any(.[]; .widget == $w)' <<<"$replacements" >/dev/null; then
    replaces["$ours"]="$(jq -r --arg w "$ours" 'first(.[] | select(.widget == $w)) | .original // ""' <<<"$replacements")"
    return
  fi
  if ! in_layout "$ours" && original="$(find_original "$source")"; then
    entry="$(layout_entry "$original")"
    read -r section index <<<"$(layout_location "$original")"
  fi
  replaces["$ours"]="$original"
  replacements="$(jq -c \
    --arg widget "$ours" --arg original "$original" --arg section "$section" \
    --arg index "$index" --argjson entry "$entry" '
      . + [{widget: $widget, original: $original, section: $section,
            index: (if $index == "" then null else ($index | tonumber) end),
            entry: $entry}]
    ' <<<"$replacements")"
}
plan_replacement "$widget_menu" omarchy.menu
plan_replacement "$widget_workspaces" omarchy.workspaces
plan_replacement "$widget_clock" omarchy.clock
plan_replacement "$widget_usage" robzolkos.agent-usage

jq -n \
  --arg id "$preset_id" --arg preset "$position" --arg backup "$original_backup" \
  --argjson hadConfig "$had_config" --argjson prior "$prior" \
  --argjson replacements "$replacements" --arg installedAt "$stamp" '
  {schema: 1, id: $id, preset: $preset, installedAt: $installedAt, backup: $backup,
   hadConfig: $hadConfig, prior: $prior, replacements: $replacements}' > "$marker.tmp"
mv -- "$marker.tmp" "$marker"

staging=""
trap '[[ -n "$staging" && -d "$staging" ]] && rm -rf -- "$staging"' EXIT
for id in "${widgets[@]}"; do
  target="$plugins/$id"
  staging="$(mktemp -d "$plugins/.omo-staging.XXXXXXXX")"
  cp -a -- "$extras/$id/." "$staging/"
  jq -n --arg id "$id" --arg preset "$preset_id" \
    '{schema: 1, id: $id, kind: "bar-preset", preset: $preset}' > "$staging/.omo-install.json"
  (cd "$staging" && find . -type f ! -name '.omo-install.json' ! -name '.omo-install.sha256' -print0 |
    sort -z | xargs -0 -r sha256sum) > "$staging/.omo-install.sha256"
  if [[ -d "$target" ]]; then
    previous="$(mktemp -d "$plugins/.omo-bar-previous.XXXXXXXX")"
    rmdir -- "$previous"
    mv -- "$target" "$previous"
    mv -- "$staging" "$target"
    rm -rf -- "$previous"
  else
    mv -- "$staging" "$target"
  fi
  staging=""
done
trap - EXIT

omarchy_shell shell rescanPlugins
for id in "${widgets[@]}"; do
  omarchy plugin validate "$plugins/$id"
done

if [[ "$(jq -r '.bar.position // "top"' "$config")" != "$position" ]]; then
  omarchy bar position "$position"
fi
clock_original="${replaces[$widget_clock]}"
if [[ -n "$clock_original" && "$(jq -r '.bar.centerAnchor // ""' "$config")" == "$clock_original" ]]; then
  commit_center_anchor "$widget_clock"
fi
wait_shell_synced

place_widget() {
  local ours="$1" source="$2" original="${replaces[$1]}" pass candidate swept
  if in_layout "$ours"; then return; fi
  if [[ -n "$original" ]] && in_layout "$original"; then
    omarchy plugin enable "$ours" --before "$original"
    # Disabling a clone puts its source back on the bar, so sweep every
    # stand-in for the stock widget until only ours remains.
    for pass in 1 2 3; do
      swept=false
      while IFS= read -r candidate; do
        [[ -n "$candidate" && "$candidate" != "$ours" ]] || continue
        if in_layout "$candidate"; then
          omarchy plugin disable "$candidate"
          swept=true
        fi
      done < <(candidates_for "$source" | awk '!seen[$0]++')
      [[ "$swept" == true ]] || break
    done
  else
    omarchy plugin enable "$ours"
  fi
  in_layout "$ours" || { echo "$ours did not land on the bar" >&2; exit 1; }
}

place_widget "$widget_menu" omarchy.menu
place_widget "$widget_workspaces" omarchy.workspaces
place_widget "$widget_clock" omarchy.clock
place_widget "$widget_usage" robzolkos.agent-usage
omarchy bar set "$widget_usage" bunPath "$(command -v bun)"
omarchy bar set "$widget_usage" senpiPath "$(command -v senpi)"

printf 'Installed the OmO bar preset (%s)\n' "$position"
