#!/usr/bin/env bash
set -euo pipefail

id=io.github.tmdgusya.omo
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$root/plugin"
layers_source="$root/art/layers"
config="$HOME/.config/omarchy/shell.json"
plugins="$HOME/.config/omarchy/plugins"
target="$plugins/$id"
marker="$target/.omo-install.json"
checksums="$target/.omo-install.sha256"
layers_parent="$plugins/art"
layers_target="$layers_parent/layers"
layers_marker="$layers_target/.omo-install.json"
layers_checksums="$layers_target/.omo-install.sha256"
top_bar=false
track_all=false

for option in "$@"; do
  case "$option" in
    --top-bar) top_bar=true ;;
    --track-all-sessions) track_all=true ;;
    *) echo "Usage: $0 [--top-bar] [--track-all-sessions]" >&2; exit 2 ;;
  esac
done

[[ -f "$source_dir/manifest.json" ]] || { echo "Bundled plugin is incomplete: missing manifest.json" >&2; exit 1; }
for required in Service.qml ambient/AmbientService.qml notify/NotificationService.qml; do
  [[ -f "$source_dir/$required" ]] ||
    { echo "Bundled plugin is incomplete: missing $required" >&2; exit 1; }
done
[[ -f "$layers_source/manifest.json" ]] ||
  { echo "Bundled plugin is incomplete: missing art/layers/manifest.json" >&2; exit 1; }
jq -e --arg id "$id" '.id == $id' "$source_dir/manifest.json" >/dev/null ||
  { echo "Bundled plugin has the wrong id" >&2; exit 1; }
omarchy plugin validate "$source_dir"
[[ "$(omarchy-shell shell ping)" == ok ]] || { echo "Omarchy shell is not running" >&2; exit 1; }

installed=false
original_position=""
explicit_senpi_path=false
explicit_launcher_path=false
tracking_source=""
tracking_agent=""
if [[ -e "$target" || -L "$target" ]]; then
  [[ -d "$target" && ! -L "$target" && -f "$marker" && -f "$checksums" ]] ||
    { echo "Refusing to overwrite unowned plugin: $target" >&2; exit 1; }
  jq -e --arg id "$id" '.id == $id and .schema == 1' "$marker" >/dev/null ||
    { echo "Refusing to overwrite unowned plugin: $target" >&2; exit 1; }
  (cd "$target" && sha256sum -c .omo-install.sha256 >/dev/null) ||
    { echo "Installed plugin was edited; refusing to overwrite it" >&2; exit 1; }
  installed=true
  original_position="$(jq -r '.originalPosition // ""' "$marker")"
  tracking_source="$(jq -r '.trackingSource // ""' "$marker")"
  tracking_agent="$(jq -r '.trackingAgentDir // ""' "$marker")"
fi

layers_installed=false
if [[ -e "$layers_target" || -L "$layers_target" ]]; then
  [[ -d "$layers_target" && ! -L "$layers_target" && -f "$layers_marker" && -f "$layers_checksums" ]] ||
    { echo "Refusing to overwrite unowned ambient layers: $layers_target" >&2; exit 1; }
  jq -e --arg id "$id" '.schema == 1 and .id == $id and .kind == "ambient-layers"' "$layers_marker" >/dev/null ||
    { echo "Refusing to overwrite unowned ambient layers: $layers_target" >&2; exit 1; }
  (cd "$layers_target" && sha256sum -c .omo-install.sha256 >/dev/null) ||
    { echo "Installed ambient layers were edited; refusing to overwrite them" >&2; exit 1; }
  layers_installed=true
fi

if [[ -f "$config" ]]; then
  jq -e '.version == 1' "$config" >/dev/null || { echo "Unsupported shell.json" >&2; exit 1; }
  if jq -e --arg id "$id" '
    any([.bar.layout.left[]?, .bar.layout.center[]?, .bar.layout.right[]?, .plugins[]?][];
      if type == "object" then .id == $id and has("senpiPath") else false end)
  ' "$config" >/dev/null; then
    explicit_senpi_path=true
  fi
  if jq -e --arg id "$id" '
    any([.bar.layout.left[]?, .bar.layout.center[]?, .bar.layout.right[]?, .plugins[]?][];
      if type == "object" then .id == $id and has("launcherPath") else false end)
  ' "$config" >/dev/null; then
    explicit_launcher_path=true
  fi
  if [[ "$installed" == false ]] && jq -e --arg id "$id" '
    any([.bar.layout.left[]?, .bar.layout.center[]?, .bar.layout.right[]?, .plugins[]?][]; .id == $id)
  ' "$config" >/dev/null; then
    echo "Refusing to take ownership of an existing layout entry" >&2
    exit 1
  fi
fi

launcher_path="$(command -v omo || command -v senpi || true)"
if [[ "$launcher_path" == */* && -f "$launcher_path" && -x "$launcher_path" ]]; then
  launcher_path="$(realpath -e -- "$launcher_path")"
else
  launcher_path=""
fi
senpi_path="$(command -v senpi || true)"
if [[ "$senpi_path" == */* && -f "$senpi_path" && -x "$senpi_path" ]]; then
  senpi_path="$(realpath -e -- "$senpi_path")"
else
  senpi_path=""
fi
if [[ "$track_all" == true || -n "$tracking_source" ]]; then
  [[ -n "$senpi_path" ]] || { echo "senpi is required for --track-all-sessions" >&2; exit 1; }
  if [[ -z "$tracking_agent" ]]; then
    tracking_agent="${SENPI_CODING_AGENT_DIR:-$HOME/.omo/agent}"
  fi
  [[ "$tracking_agent" == /* ]] || { echo "Tracking agent directory must be absolute" >&2; exit 1; }
  tracking_source="$target/omo-status.ts"
fi

position="$(jq -r '.bar.position // "top"' "$config" 2>/dev/null || echo top)"
if [[ "$top_bar" == true && -z "$original_position" && "$position" != top ]]; then
  original_position="$position"
fi

mkdir -p -- "$plugins" "$layers_parent"
if [[ -f "$config" ]]; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$config.bak.omo.$stamp"
  n=1
  while [[ -e "$backup" ]]; do backup="$config.bak.omo.$stamp.$n"; ((n+=1)); done
  cp -p -- "$config" "$backup"
  printf 'Saved layout backup: %s\n' "$backup"
fi

staging="$(mktemp -d "$plugins/.omo-staging.XXXXXXXX")"
layers_staging="$(mktemp -d "$layers_parent/.omo-staging.XXXXXXXX")"
trap '[[ -d "$staging" ]] && rm -rf -- "$staging"; [[ -d "$layers_staging" ]] && rm -rf -- "$layers_staging"' EXIT
cp -a -- "$source_dir/." "$staging/"
cp -a -- "$layers_source/." "$layers_staging/"
jq -n --arg id "$id" --arg position "$original_position" \
  --arg source "$tracking_source" --arg agent "$tracking_agent" \
  '{schema: 1, id: $id, originalPosition: $position}
   + (if $source != "" then {trackingSource: $source, trackingAgentDir: $agent} else {} end)' > "$staging/.omo-install.json"
(cd "$staging" && find . -type f ! -name '.omo-install.json' ! -name '.omo-install.sha256' -print0 |
  sort -z | xargs -0 -r sha256sum) > "$staging/.omo-install.sha256"
jq -n --arg id "$id" '{schema: 1, id: $id, kind: "ambient-layers"}' > "$layers_staging/.omo-install.json"
(cd "$layers_staging" && find . -type f ! -name '.omo-install.json' ! -name '.omo-install.sha256' -print0 |
  sort -z | xargs -0 -r sha256sum) > "$layers_staging/.omo-install.sha256"
if [[ "$installed" == true ]]; then
  previous="$(mktemp -d "$plugins/.omo-previous.XXXXXXXX")"
  rmdir -- "$previous"
  mv -- "$target" "$previous"
  mv -- "$staging" "$target"
  printf 'Previous plugin retained: %s\n' "$previous"
else
  mv -- "$staging" "$target"
fi
if [[ "$layers_installed" == true ]]; then
  previous_layers="$(mktemp -d "$layers_parent/.omo-previous.XXXXXXXX")"
  rmdir -- "$previous_layers"
  mv -- "$layers_target" "$previous_layers"
  mv -- "$layers_staging" "$layers_target"
  printf 'Previous ambient layers retained: %s\n' "$previous_layers"
else
  mv -- "$layers_staging" "$layers_target"
fi
if [[ "$track_all" == true || -n "$tracking_source" ]]; then
  SENPI_CODING_AGENT_DIR="$tracking_agent" "$senpi_path" install "$tracking_source"
fi
omarchy-shell shell rescanPlugins
omarchy plugin validate "$target"
if [[ "$installed" == false ]]; then
  omarchy plugin enable "$id" --section left
fi
if [[ "$explicit_launcher_path" == false ]]; then
  if [[ -n "$launcher_path" ]]; then
    omarchy bar set "$id" launcherPath "$launcher_path"
  else
    echo "Neither omo nor senpi was found; set launcherPath to an absolute executable path for Launch." >&2
  fi
fi
if [[ -n "$tracking_source" ]]; then
  omarchy bar set "$id" trackingInstalled true
fi
if [[ "$explicit_senpi_path" == false ]]; then
  if [[ -n "$senpi_path" ]]; then
    omarchy bar set "$id" senpiPath "$senpi_path"
  else
    echo "senpi was not found in the installer PATH; set the widget senpiPath to an absolute executable path for Launch." >&2
  fi
fi
if [[ "$top_bar" == true && "$position" != top ]]; then
  omarchy bar position top
fi
if [[ "$installed" == true ]]; then
  # Replacing a plugin directory does not invalidate loaded QML components.
  omarchy restart shell
fi
printf 'Installed %s\n' "$id"
